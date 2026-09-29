/**
 * The memory contract every backend implements. Kept deliberately small so
 * Hindsight, Cognee, the local store, or a future engine can slot in without
 * the rest of the harness knowing which one answered.
 *
 * @module dsh-memory/types
 */

/**
 * What a memory is about. Mirrors the executive agent's needs:
 * `experience` — what the agent did and what happened;
 * `fact` — knowledge about the world or the user;
 * `self` — the agent's own identity, preferences, and self-model;
 * `skill` — how to do something that worked before.
 */
export type MemoryKind = 'experience' | 'fact' | 'self' | 'skill'

export const MEMORY_KINDS: readonly MemoryKind[] = ['experience', 'fact', 'self', 'skill']

export interface MemoryItem {
  content: string
  kind?: MemoryKind | undefined
  /** Free-form context, e.g. the task or session the memory came from. */
  context?: string | undefined
  /** ISO-8601; defaults to now. */
  timestamp?: string | undefined
  tags?: string[] | undefined
}

export interface MemoryHit {
  content: string
  /** 0..1 relevance, backend-normalized; higher is better. */
  score: number
  /** Which backend produced it. */
  source: string
  kind?: MemoryKind | undefined
  timestamp?: string | undefined
}

export interface RecallOptions {
  limit?: number | undefined
  kinds?: MemoryKind[] | undefined
  signal?: AbortSignal | undefined
}

export interface Reflection {
  answer: string
  source: string
}

export interface MemoryBackend {
  /** Stable id, e.g. `local`, `hindsight`, `cognee`. */
  readonly id: string
  retain(items: readonly MemoryItem[], signal?: AbortSignal): Promise<void>
  recall(query: string, options: RecallOptions): Promise<MemoryHit[]>
  /** Optional: synthesize an answer from memory rather than list hits. */
  reflect?(query: string, signal?: AbortSignal): Promise<Reflection | undefined>
  /** Optional liveness check; a failing backend is skipped, not fatal. */
  health?(signal?: AbortSignal): Promise<boolean>
}
