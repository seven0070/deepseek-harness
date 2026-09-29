/**
 * World model and uncertainty. Beliefs are statements with a probability,
 * updated in log-odds space from evidence of stated reliability, so
 * independent confirmations compound and a single weak source cannot produce
 * certainty. Unverified beliefs decay toward 0.5 over time. Calibration
 * tracks how well stated confidence matched outcomes (Brier score).
 *
 * @module dsh-executive/world
 */
import { randomUUID } from 'node:crypto'

export interface Evidence {
  source: string
  /** Does it support (true) or contradict (false) the statement? */
  supports: boolean
  /** 0.5 (useless) … 0.99 (near-certain); how often this kind of source is right. */
  reliability: number
  at: string
}

export interface Belief {
  id: string
  statement: string
  confidence: number
  evidence: Evidence[]
  verified: boolean
  updatedAt: string
}

export interface WorldState {
  beliefs: Belief[]
  predictions: { id: string, statement: string, confidence: number, outcome?: boolean | undefined }[]
}

const logit = (p: number): number => Math.log(p / (1 - p))
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))
const clampP = (p: number): number => Math.min(0.999, Math.max(0.001, p))

function norm(statement: string): string {
  return statement.toLowerCase().replace(/\s+/g, ' ').trim()
}

export type ConfidenceBand = 'unknown' | 'doubtful' | 'uncertain' | 'likely' | 'confident' | 'verified'

export function band(belief: Pick<Belief, 'confidence' | 'verified'>): ConfidenceBand {
  if (belief.verified && belief.confidence >= 0.95) return 'verified'
  const c = belief.confidence
  if (c >= 0.9) return 'confident'
  if (c >= 0.7) return 'likely'
  if (c > 0.3) return c === 0.5 ? 'unknown' : 'uncertain'
  return 'doubtful'
}

export class WorldModel {
  constructor(
    private state: WorldState = { beliefs: [], predictions: [] },
    private readonly options: { now?: () => Date, halfLifeDays?: number } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  toJSON(): WorldState {
    return structuredClone(this.state)
  }

  find(statement: string): Belief | undefined {
    const key = norm(statement)
    return this.state.beliefs.find((b) => norm(b.statement) === key)
  }

  /** Current confidence after time decay (unverified beliefs drift toward 0.5). */
  confidence(belief: Belief): number {
    if (belief.verified) return belief.confidence
    const days = (this.now().getTime() - Date.parse(belief.updatedAt)) / 86_400_000
    const halfLife = this.options.halfLifeDays ?? 30
    const keep = Math.pow(0.5, Math.max(0, days) / halfLife)
    return 0.5 + (belief.confidence - 0.5) * keep
  }

  observe(statement: string, evidence: Omit<Evidence, 'at'>, options: { verified?: boolean } = {}): Belief {
    const at = this.now().toISOString()
    let belief = this.find(statement)
    if (!belief) {
      belief = { id: randomUUID().slice(0, 8), statement: statement.trim(), confidence: 0.5, evidence: [], verified: false, updatedAt: at }
      this.state.beliefs.push(belief)
    }
    const r = clampP(Math.min(0.99, Math.max(0.5, evidence.reliability)))
    const prior = logit(clampP(this.confidence(belief)))
    // Repeated evidence from the same source is not independent: discount it.
    const repeats = belief.evidence.filter((e) => e.source === evidence.source).length
    const weight = 1 / (1 + repeats)
    belief.confidence = sigmoid(prior + (evidence.supports ? 1 : -1) * logit(r) * weight)
    belief.evidence = [...belief.evidence, { ...evidence, reliability: r, at }].slice(-20)
    belief.verified = options.verified ?? (belief.verified && evidence.supports)
    if (options.verified === true) belief.confidence = Math.max(belief.confidence, 0.97)
    belief.updatedAt = at
    return belief
  }

  query(text: string, limit = 10): (Belief & { current: number, band: ConfidenceBand })[] {
    const words = norm(text).split(' ').filter((w) => w.length > 2)
    return this.state.beliefs
      .map((b) => ({ b, hits: words.filter((w) => norm(b.statement).includes(w)).length }))
      .filter((x) => x.hits > 0 || !words.length)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit)
      .map(({ b }) => {
        const current = this.confidence(b)
        return { ...b, current, band: band({ confidence: current, verified: b.verified }) }
      })
  }

  /** Beliefs that have evidence on both sides — worth investigating. */
  contested(): Belief[] {
    return this.state.beliefs.filter((b) => b.evidence.some((e) => e.supports) && b.evidence.some((e) => !e.supports))
  }

  predict(statement: string, confidence: number): string {
    const id = randomUUID().slice(0, 8)
    this.state.predictions.push({ id, statement, confidence: clampP(confidence) })
    return id
  }

  resolve(id: string, outcome: boolean): void {
    const p = this.state.predictions.find((x) => x.id === id)
    if (!p) throw new Error(`world: no prediction ${id}`)
    p.outcome = outcome
  }

  /** Brier score (0 = perfect, 0.25 = coin flip) over resolved predictions. */
  calibration(): { resolved: number, brier: number | undefined, overconfident: boolean | undefined } {
    const done = this.state.predictions.filter((p) => p.outcome !== undefined)
    if (!done.length) return { resolved: 0, brier: undefined, overconfident: undefined }
    const brier = done.reduce((s, p) => s + (p.confidence - (p.outcome ? 1 : 0)) ** 2, 0) / done.length
    const meanConf = done.reduce((s, p) => s + p.confidence, 0) / done.length
    const hitRate = done.filter((p) => p.outcome).length / done.length
    return { resolved: done.length, brier, overconfident: meanConf > hitRate + 0.1 }
  }
}

/**
 * Should the agent verify before acting on a belief? Higher stakes demand
 * higher confidence; `verified` beliefs always pass.
 */
export function needsVerification(confidence: number, stakes: 'low' | 'medium' | 'high', verified = false): boolean {
  if (verified) return false
  const threshold = { low: 0.6, medium: 0.8, high: 0.95 }[stakes]
  return confidence < threshold
}
