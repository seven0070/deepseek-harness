/**
 * The memory service: fans every operation out to all registered backends,
 * merges and de-duplicates recall hits, and degrades gracefully — a backend
 * that errors or times out is reported and skipped, never fatal.
 *
 * @module dsh-memory/service
 */
import type { MemoryBackend, MemoryHit, MemoryItem, RecallOptions, Reflection } from './types.ts'

export interface MemoryServiceOptions {
  /** Per-backend deadline for one operation. */
  timeoutMs?: number
  /** Relative trust per backend id when merging scores; default 1. */
  weights?: Record<string, number>
  onError?: (backend: string, operation: string, error: unknown) => void
}

export interface RecallResult {
  hits: MemoryHit[]
  /** Backends that failed this call. */
  failed: string[]
}

function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('aborted'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    task(signal).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Normalize for duplicate detection across backends. */
function fingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim()
}

export class MemoryService {
  private readonly backends = new Map<string, MemoryBackend>()

  constructor(private readonly options: MemoryServiceOptions = {}) {}

  /** @returns an unregister function. */
  register(backend: MemoryBackend): () => void {
    if (this.backends.has(backend.id)) throw new Error(`memory: backend "${backend.id}" is already registered`)
    this.backends.set(backend.id, backend)
    return () => {
      if (this.backends.get(backend.id) === backend) this.backends.delete(backend.id)
    }
  }

  list(): string[] {
    return [...this.backends.keys()]
  }

  private get timeout(): number {
    return this.options.timeoutMs ?? 10_000
  }

  private fail(backend: string, operation: string, error: unknown): void {
    this.options.onError?.(backend, operation, error)
  }

  /** Store in every backend. @returns the ids that failed. */
  async retain(items: readonly MemoryItem[], signal?: AbortSignal): Promise<string[]> {
    const clean = items.filter((i) => i.content.trim())
    if (!clean.length) return []
    const failed: string[] = []
    await Promise.all([...this.backends.values()].map(async (b) => {
      try {
        await withTimeout((s) => b.retain(clean, s), this.timeout, signal)
      } catch (error) {
        failed.push(b.id)
        this.fail(b.id, 'retain', error)
      }
    }))
    return failed.sort()
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const limit = options.limit ?? 8
    const failed: string[] = []
    const lists = await Promise.all([...this.backends.values()].map(async (b) => {
      try {
        const hits = await withTimeout((s) => b.recall(query, { ...options, limit, signal: s }), this.timeout, options.signal)
        const weight = this.options.weights?.[b.id] ?? 1
        return hits.map((h) => ({ ...h, score: Math.max(0, Math.min(1, h.score)) * weight }))
      } catch (error) {
        failed.push(b.id)
        this.fail(b.id, 'recall', error)
        return []
      }
    }))
    const merged = new Map<string, MemoryHit>()
    for (const hit of lists.flat()) {
      const key = fingerprint(hit.content)
      const prior = merged.get(key)
      // Agreement between backends is evidence: keep the best, add a bonus.
      if (!prior) merged.set(key, hit)
      else merged.set(key, { ...(hit.score > prior.score ? hit : prior), score: Math.max(hit.score, prior.score) + 0.1 * Math.min(hit.score, prior.score) })
    }
    const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    return { hits, failed: failed.sort() }
  }

  /**
   * Ask the first backend that can reflect; fall back to listing recalled
   * memories when none can.
   */
  async reflect(query: string, signal?: AbortSignal): Promise<Reflection> {
    for (const b of this.backends.values()) {
      if (!b.reflect) continue
      try {
        const answer = await withTimeout((s) => b.reflect!(query, s), this.timeout * 3, signal)
        if (answer?.answer.trim()) return answer
      } catch (error) {
        this.fail(b.id, 'reflect', error)
      }
    }
    const { hits } = await this.recall(query, { limit: 5, signal })
    return {
      answer: hits.length ? hits.map((h) => `- ${h.content}`).join('\n') : 'No relevant memories.',
      source: 'recall',
    }
  }

  async health(signal?: AbortSignal): Promise<Record<string, boolean>> {
    const entries = await Promise.all([...this.backends.values()].map(async (b) => {
      if (!b.health) return [b.id, true] as const
      try {
        return [b.id, await withTimeout((s) => b.health!(s), this.timeout, signal)] as const
      } catch {
        return [b.id, false] as const
      }
    }))
    return Object.fromEntries(entries)
  }
}
