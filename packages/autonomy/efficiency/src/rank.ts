/**
 * Tool choice in two stages (idea from OpenHuman's "Jev", re-implemented):
 *
 *  1. Retrieve: BM25 over tool names and descriptions → top-k candidates.
 *  2. Decide: a chooser returns a probability for each candidate plus
 *     "no tool needed". The default chooser turns BM25 scores into a
 *     temperature-scaled softmax; a model-backed chooser (a small, cheap model
 *     that only answers with probabilities, never prose) can be plugged in.
 *
 * Low top probability ⇒ abstain, which avoids needless tool calls.
 *
 * @module dsh-efficiency/rank
 */

export interface ToolDoc {
  name: string
  description: string
}

export interface Ranked {
  name: string
  score: number
}

export interface Decision {
  /** Chosen tool, or undefined when abstaining ("no tool needed" / unsure). */
  choice?: string | undefined
  /** Probability per candidate plus `none`; sums to 1. */
  probabilities: Record<string, number>
  candidates: Ranked[]
  abstained: boolean
  reason: string
}

/** A chooser returns unnormalized non-negative weights per option (`none` included). */
export type Chooser = (query: string, candidates: readonly ToolDoc[], signal?: AbortSignal) => Promise<Record<string, number>>

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'is', 'it', 'this', 'that', 'my', 'me', 'i', 'you', 'your', 'be', 'by', 'from', 'as', 'at', 'use', 'when'])

export function tokenize(text: string): string[] {
  return (text.toLowerCase().replace(/[_-]/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => !STOP.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t))
}

export class ToolIndex {
  private docs: { doc: ToolDoc, terms: Map<string, number>, len: number }[] = []
  private df = new Map<string, number>()
  private avgLen = 1

  constructor(docs: readonly ToolDoc[] = []) {
    this.set(docs)
  }

  set(docs: readonly ToolDoc[]): void {
    this.df.clear()
    this.docs = docs.map((doc) => {
      // Name terms count double: they are the strongest signal.
      const toks = [...tokenize(doc.name), ...tokenize(doc.name), ...tokenize(doc.description)]
      const terms = new Map<string, number>()
      for (const t of toks) terms.set(t, (terms.get(t) ?? 0) + 1)
      for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      return { doc, terms, len: toks.length }
    })
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length) || 1
  }

  get size(): number {
    return this.docs.length
  }

  doc(name: string): ToolDoc | undefined {
    return this.docs.find((d) => d.doc.name === name)?.doc
  }

  /**
   * Best score any single document could reach for this query, counting only
   * terms that exist in the vocabulary. Used to turn raw BM25 into coverage (0..1).
   */
  maxScore(query: string): number {
    const N = this.docs.length
    let max = 0
    for (const t of new Set(tokenize(query))) {
      const n = this.df.get(t)
      if (!n) continue
      max += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * 2.2 / (1 + 1.2 * 0.25) // f→∞-ish, short doc
    }
    return max
  }

  search(query: string, k = 10): Ranked[] {
    const q = [...new Set(tokenize(query))]
    const N = this.docs.length
    const k1 = 1.2
    const b = 0.75
    const out: Ranked[] = []
    for (const d of this.docs) {
      let score = 0
      for (const t of q) {
        const f = d.terms.get(t)
        if (!f) continue
        const n = this.df.get(t) ?? 0
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
        score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / this.avgLen))
      }
      if (score > 0) out.push({ name: d.doc.name, score })
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, k)
  }
}

/**
 * Default chooser: softmax over coverage (BM25 score ÷ best reachable score
 * for the query), against a fixed "none" coverage. Coverage makes the
 * probabilities comparable across queries and index sizes.
 */
export function bm25Chooser(index: ToolIndex, options: { temperature?: number, noneCoverage?: number } = {}): Chooser {
  const temperature = options.temperature ?? 0.1
  const noneCoverage = options.noneCoverage ?? 0.2
  return async (query, candidates) => {
    const max = index.maxScore(query) || 1
    const scores = new Map(index.search(query, index.size).map((r) => [r.name, r.score]))
    const weights: Record<string, number> = { none: Math.exp(noneCoverage / temperature) }
    for (const c of candidates) weights[c.name] = Math.exp(Math.min(1, (scores.get(c.name) ?? 0) / max) / temperature)
    return weights
  }
}

export async function decide(index: ToolIndex, query: string, options: {
  k?: number
  chooser?: Chooser
  /** Minimum top probability to commit to a tool. */
  threshold?: number
  signal?: AbortSignal
} = {}): Promise<Decision> {
  const candidates = index.search(query, options.k ?? 20)
  if (!candidates.length) return { probabilities: { none: 1 }, candidates, abstained: true, reason: 'no tool matches the request' }
  const chooser = options.chooser ?? bm25Chooser(index)
  let raw: Record<string, number>
  try {
    raw = await chooser(query, candidates.map((c) => index.doc(c.name)!), options.signal)
  } catch {
    raw = await bm25Chooser(index)(query, candidates.map((c) => index.doc(c.name)!))
  }
  const allowed = new Set([...candidates.map((c) => c.name), 'none'])
  const entries = Object.entries(raw).filter(([k, v]) => allowed.has(k) && Number.isFinite(v) && v >= 0)
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1
  const probabilities = Object.fromEntries(entries.map(([k, v]) => [k, v / total]))
  const [top, p] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ['none', 1]
  const threshold = options.threshold ?? 0.35
  if (top === 'none') return { probabilities, candidates, abstained: true, reason: `no tool needed (p=${p.toFixed(2)})` }
  if (p < threshold) return { probabilities, candidates, abstained: true, reason: `unsure: best is ${top} at p=${p.toFixed(2)} < ${threshold}` }
  return { choice: top, probabilities, candidates, abstained: false, reason: `${top} (p=${p.toFixed(2)})` }
}
