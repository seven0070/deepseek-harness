/**
 * Zero-dependency local backend so memory works with no external service.
 * Keyword (BM25-style) ranking with a mild recency boost; optionally
 * persisted as JSON Lines. Not a replacement for Hindsight or Cognee — a
 * floor that keeps the agent from forgetting everything when they are off.
 *
 * @module dsh-memory/local
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MemoryBackend, MemoryHit, MemoryItem, RecallOptions } from './types.ts'

interface Stored extends MemoryItem {
  timestamp: string
  terms: string[]
}

const STOP = new Set('a an and are as at be by for from has have i in is it its of on or that the this to was were will with you your'.split(' '))

export function tokenize(text: string): string[] {
  return text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1 && !STOP.has(t))
}

export class LocalMemory implements MemoryBackend {
  readonly id = 'local'
  private items: Stored[] = []
  private loaded: Promise<void> | undefined

  constructor(private readonly options: { path?: string | undefined, maxItems?: number, now?: () => Date } = {}) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.options.path) return
      let text = ''
      try { text = await readFile(this.options.path, 'utf8') } catch { return }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const item = JSON.parse(line) as MemoryItem & { timestamp: string }
          this.items.push({ ...item, terms: tokenize(item.content) })
        } catch { /* skip a torn line rather than lose the store */ }
      }
      this.trim()
    })()
    return this.loaded
  }

  private trim(): void {
    const max = this.options.maxItems ?? 10_000
    if (this.items.length > max) this.items = this.items.slice(-max)
  }

  get size(): number {
    return this.items.length
  }

  async retain(items: readonly MemoryItem[]): Promise<void> {
    await this.load()
    const stored = items.filter((i) => i.content.trim()).map((i): Stored => ({
      ...i,
      content: i.content.trim(),
      timestamp: i.timestamp ?? this.now().toISOString(),
      terms: tokenize(i.content),
    }))
    this.items.push(...stored)
    this.trim()
    if (this.options.path && stored.length) {
      await mkdir(dirname(this.options.path), { recursive: true })
      await appendFile(this.options.path, stored.map(({ terms: _, ...rest }) => JSON.stringify(rest)).join('\n') + '\n')
    }
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryHit[]> {
    await this.load()
    const q = [...new Set(tokenize(query))]
    if (!q.length) return []
    const pool = options.kinds?.length ? this.items.filter((i) => i.kind && options.kinds!.includes(i.kind)) : this.items
    const n = pool.length
    const avg = pool.reduce((s, i) => s + i.terms.length, 0) / Math.max(1, n)
    const df = new Map(q.map((t) => [t, pool.filter((i) => i.terms.includes(t)).length]))
    const now = this.now().getTime()
    const scored = pool.map((item) => {
      let bm25 = 0
      for (const t of q) {
        const tf = item.terms.filter((x) => x === t).length
        if (!tf) continue
        const idf = Math.log(1 + (n - df.get(t)! + 0.5) / (df.get(t)! + 0.5))
        bm25 += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * item.terms.length / Math.max(1, avg)))
      }
      const ageDays = Math.max(0, (now - Date.parse(item.timestamp)) / 86_400_000)
      return { item, raw: bm25 * (1 + 0.2 / (1 + ageDays / 30)) }
    }).filter((s) => s.raw > 0).sort((a, b) => b.raw - a.raw)
    const top = scored[0]?.raw ?? 1
    return scored.slice(0, options.limit ?? 10).map(({ item, raw }) => ({
      content: item.content,
      score: raw / top,
      source: this.id,
      kind: item.kind,
      timestamp: item.timestamp,
    }))
  }
}
