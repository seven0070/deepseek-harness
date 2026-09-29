/**
 * Replayable run journal with per-call cost accounting (idea from OpenHuman,
 * re-implemented). Every model call and tool call becomes one JSON line:
 * what ran, how long it took, how many tokens it used, and what it cost. A
 * run can be replayed as an ordered timeline and summarised by cost.
 *
 * @module dsh-efficiency/journal
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface Price {
  /** USD per million input tokens. */
  input: number
  /** USD per million output tokens. */
  output: number
  /** USD per million cached input tokens (defaults to input). */
  cacheRead?: number | undefined
}

export type JournalEntry =
  | {
    kind: 'llm'
    run: string
    at: string
    model: string
    durationMs: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    costUsd?: number | undefined
    finish?: string | undefined
    error?: string | undefined
  }
  | {
    kind: 'tool'
    run: string
    at: string
    tool: string
    callId: string
    durationMs?: number | undefined
    isError: boolean
    args: unknown
    outputChars: number
    compressedFrom?: number | undefined
  }

/** Glob-ish model matching: `*` wildcard, case-insensitive. */
export function priceFor(model: string, prices: Record<string, Price>): Price | undefined {
  const m = model.toLowerCase()
  let best: [number, Price] | undefined
  for (const [pattern, price] of Object.entries(prices)) {
    const re = new RegExp(`^${pattern.toLowerCase().split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    if (re.test(m) && (!best || pattern.length > best[0])) best = [pattern.length, price]
  }
  return best?.[1]
}

export function costOf(usage: { inputTokens: number, outputTokens: number, cacheReadTokens?: number | undefined }, price: Price | undefined): number | undefined {
  if (!price) return undefined
  const cached = usage.cacheReadTokens ?? 0
  const fresh = Math.max(0, usage.inputTokens - cached)
  return (fresh * price.input + cached * (price.cacheRead ?? price.input) + usage.outputTokens * price.output) / 1e6
}

export interface RunSummary {
  run: string
  llmCalls: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  unpricedCalls: number
  byModel: Record<string, { calls: number, costUsd: number, tokens: number }>
  byTool: Record<string, { calls: number, errors: number }>
  savedChars: number
}

export class Journal {
  private readonly entries: JournalEntry[] = []

  constructor(private readonly options: { path?: string | undefined, keep?: number } = {}) {}

  async record(entry: JournalEntry): Promise<void> {
    this.entries.push(entry)
    if (this.entries.length > (this.options.keep ?? 5000)) this.entries.shift()
    if (this.options.path) {
      await mkdir(dirname(this.options.path), { recursive: true })
      await appendFile(this.options.path, `${JSON.stringify(entry)}\n`)
    }
  }

  /** Load earlier runs from disk (for replay across restarts). */
  async load(): Promise<void> {
    if (!this.options.path) return
    let text = ''
    try { text = await readFile(this.options.path, 'utf8') } catch { return }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { this.entries.push(JSON.parse(line) as JournalEntry) } catch {}
    }
  }

  runs(): string[] {
    return [...new Set(this.entries.map((e) => e.run))]
  }

  replay(run: string): JournalEntry[] {
    return this.entries.filter((e) => e.run === run)
  }

  summary(run: string): RunSummary {
    const s: RunSummary = { run, llmCalls: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0, byModel: {}, byTool: {}, savedChars: 0 }
    for (const e of this.replay(run)) {
      if (e.kind === 'llm') {
        s.llmCalls++
        s.inputTokens += e.inputTokens
        s.outputTokens += e.outputTokens
        const m = (s.byModel[e.model] ??= { calls: 0, costUsd: 0, tokens: 0 })
        m.calls++
        m.tokens += e.inputTokens + e.outputTokens
        if (e.costUsd === undefined) s.unpricedCalls++
        else { s.costUsd += e.costUsd; m.costUsd += e.costUsd }
      } else {
        s.toolCalls++
        if (e.isError) s.toolErrors++
        const t = (s.byTool[e.tool] ??= { calls: 0, errors: 0 })
        t.calls++
        if (e.isError) t.errors++
        if (e.compressedFrom !== undefined) s.savedChars += e.compressedFrom - e.outputChars
      }
    }
    return s
  }

  /** Human-readable timeline. */
  format(run: string): string {
    return this.replay(run).map((e) => e.kind === 'llm'
      ? `${e.at.slice(11, 19)} llm  ${e.model} in=${e.inputTokens} out=${e.outputTokens} ${e.durationMs}ms${e.costUsd !== undefined ? ` $${e.costUsd.toFixed(5)}` : ''}${e.error ? ` ERROR ${e.error}` : ''}`
      : `${e.at.slice(11, 19)} tool ${e.tool}${e.isError ? ' ERROR' : ''} ${e.outputChars} chars${e.compressedFrom !== undefined ? ` (from ${e.compressedFrom})` : ''}${e.durationMs !== undefined ? ` ${e.durationMs}ms` : ''}`).join('\n')
  }
}
