/**
 * API-key provider detection: shape rules, env-name hints, and an optional
 * live probe that settles ambiguous shapes. Pure except for the injected
 * `fetch`, so it is testable offline.
 *
 * @module dsh-llm-router/detect
 */

import { ENV_HINTS, KEY_RULES, PROBES } from './rules.ts'
import type { Confidence, KeyRule, ProbeSpec } from './rules.ts'

export interface Candidate {
  provider: string
  confidence: Confidence
  /** Why this candidate was proposed. */
  reason: 'shape' | 'env-name' | 'probe'
}

export interface Detection {
  /** Best guess, or `undefined` when nothing matched. */
  provider?: string | undefined
  /** Every plausible provider, best first. */
  candidates: Candidate[]
  /** True when the winner is not unique and a probe is advisable. */
  ambiguous: boolean
}

const RANK: Record<Confidence, number> = { exact: 3, likely: 2, weak: 1 }

/**
 * Rank the providers a key could belong to.
 * @param key - raw key; surrounding whitespace and quotes are ignored.
 * @param envName - variable the key came from, when known.
 * @param rules - override the built-in rule table.
 */
export function detectKey(key: string, envName?: string, rules: readonly KeyRule[] = KEY_RULES): Detection {
  const value = normalizeKey(key)
  const best = new Map<string, Candidate & { specificity: number }>()
  const offer = (candidate: Candidate, specificity: number): void => {
    const prior = best.get(candidate.provider)
    if (!prior || RANK[candidate.confidence] > RANK[prior.confidence]
      || (RANK[candidate.confidence] === RANK[prior.confidence] && specificity > prior.specificity)) {
      best.set(candidate.provider, { ...candidate, specificity })
    }
  }
  if (value) {
    for (const rule of rules) {
      if (rule.pattern.test(value)) {
        offer({ provider: rule.provider, confidence: rule.confidence, reason: 'shape' }, rule.pattern.source.length)
      }
    }
  }
  const hinted = envName ? ENV_HINTS[envName.toUpperCase()] : undefined
  if (hinted && value) offer({ provider: hinted, confidence: 'exact', reason: 'env-name' }, Number.MAX_SAFE_INTEGER)

  const candidates = [...best.values()]
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || b.specificity - a.specificity)
    .map(({ specificity: _, ...candidate }) => candidate)
  const top = candidates[0]
  const ambiguous = !!top && (top.confidence !== 'exact'
    || candidates.filter((c) => c.confidence === 'exact').length > 1)
  return { provider: top?.provider, candidates, ambiguous }
}

export type FetchLike = (url: string, init: { headers: Record<string, string>, signal?: AbortSignal }) => Promise<{ status: number }>

export interface ProbeOptions {
  fetch?: FetchLike
  timeoutMs?: number
  probes?: Readonly<Record<string, ProbeSpec>>
}

/**
 * Ask one provider whether it accepts the key. Read-only listing endpoints
 * only, so a probe never spends tokens.
 * @returns true on 2xx, false on 401/403, undefined when inconclusive.
 */
export async function probeKey(provider: string, key: string, options: ProbeOptions = {}): Promise<boolean | undefined> {
  const spec = (options.probes ?? PROBES)[provider]
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (!spec || !doFetch) return undefined
  const value = normalizeKey(key)
  const headers: Record<string, string> = { ...spec.headers }
  let url = spec.url
  if (spec.auth === 'bearer') headers.authorization = `Bearer ${value}`
  else if (spec.auth === 'x-api-key') headers['x-api-key'] = value
  else url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(value)}`
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5000)
  try {
    const { status } = await doFetch(url, { headers, signal })
    if (status >= 200 && status < 300) return true
    if (status === 401 || status === 403) return false
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Detect, then — when ambiguous — probe candidates in rank order and promote
 * the first one that accepts the key. Candidates that reject it are dropped.
 */
export async function resolveKey(key: string, envName?: string, options: ProbeOptions = {}): Promise<Detection> {
  const detection = detectKey(key, envName)
  if (!detection.ambiguous) return detection
  const kept: Candidate[] = []
  for (const candidate of detection.candidates) {
    const verdict = await probeKey(candidate.provider, key, options)
    if (verdict === true) {
      const winner: Candidate = { ...candidate, confidence: 'exact', reason: 'probe' }
      const rest = detection.candidates.filter((c) => c !== candidate)
      return { provider: winner.provider, candidates: [winner, ...rest], ambiguous: false }
    }
    if (verdict === undefined) kept.push(candidate)
  }
  return { provider: kept[0]?.provider, candidates: kept, ambiguous: kept.length !== 1 || kept[0]?.confidence !== 'exact' }
}

/** Strip whitespace, surrounding quotes, and a pasted `Bearer ` prefix. */
export function normalizeKey(key: string): string {
  return key.trim().replace(/^['"]|['"]$/g, '').replace(/^Bearer\s+/i, '').trim()
}

/** Show a key safely in logs and UIs. */
export function maskKey(key: string): string {
  const value = normalizeKey(key)
  return value.length <= 10 ? '***' : `${value.slice(0, 6)}…${value.slice(-4)}`
}

export interface FoundKey {
  envName: string
  key: string
}

/**
 * Collect key-looking variables from an environment: every conventionally
 * hinted name plus anything ending in `_API_KEY`.
 */
export function scanEnv(env: Readonly<Record<string, string | undefined>>): FoundKey[] {
  const found: FoundKey[] = []
  for (const [envName, raw] of Object.entries(env)) {
    if (!raw || !normalizeKey(raw)) continue
    const upper = envName.toUpperCase()
    if (upper in ENV_HINTS || upper.endsWith('_API_KEY')) found.push({ envName, key: raw })
  }
  return found.sort((a, b) => a.envName.localeCompare(b.envName))
}
