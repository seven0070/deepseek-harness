/**
 * Cognee backend (https://github.com/topoteretes/cognee). Cognee turns what
 * it ingests into a knowledge graph of entities and relationships and answers
 * graph-aware searches. Runs as a separate server (Docker or Cognee Cloud);
 * this plugin talks to its `/api/v1` REST API.
 *
 * Ingestion is two-phase in Cognee — `add` stores raw data, `cognify` builds
 * the graph — so retained items are batched and cognified after a short
 * debounce instead of once per memory.
 *
 * ```yaml
 * - id: memory-cognee
 *   name: '@deepseek-ai/dsh-memory-cognee'
 *   config:
 *     baseUrl: http://127.0.0.1:8000
 *     dataset: primary
 *     apiKeyEnv: COGNEE_API_KEY   # only for Cognee Cloud
 * ```
 *
 * @module @deepseek-ai/dsh-memory-cognee
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defaultFetch, requestJson } from '@deepseek-ai/dsh-memory'
import type { FetchLike, MemoryBackend, MemoryHit, MemoryItem, RecallOptions, Reflection } from '@deepseek-ai/dsh-memory'

export const name = 'memory-cognee'
export const inject = ['memory']

export type SearchType = 'GRAPH_COMPLETION' | 'RAG_COMPLETION' | 'CHUNKS' | 'SUMMARIES' | 'INSIGHTS'

export interface Config {
  /** Cognee server URL, without the `/api/v1` prefix. */
  baseUrl: string
  /** Cognee dataset; one per agent identity. */
  dataset: string
  /** Environment variable holding a Cognee Cloud API key. */
  apiKeyEnv?: string | undefined
  /** Cognee search mode used for recall. */
  recallSearchType: SearchType
  /** Batch retains before building the graph. */
  cognifyDebounceMs: number
  /** Test seam. */
  fetch?: FetchLike | undefined
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://127.0.0.1:8000'),
  dataset: z.string().default('primary').description('Cognee dataset; one per agent identity.'),
  apiKeyEnv: z.string().description('Environment variable holding a Cognee Cloud API key.'),
  recallSearchType: z.union(['CHUNKS', 'SUMMARIES', 'INSIGHTS', 'RAG_COMPLETION', 'GRAPH_COMPLETION']).default('CHUNKS'),
  cognifyDebounceMs: z.natural().default(5_000).description('Batch retains before building the graph.'),
}) as z<Config>

type SearchResponse = unknown[] | { results?: unknown[] } | string | undefined

/** Cognee's search payloads vary by search type; pull readable text out of any of them. */
export function textsOf(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) return value.flatMap((v) => textsOf(v, depth + 1))
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'content', 'summary', 'answer', 'search_result']) {
      if (key in record) return textsOf(record[key], depth + 1)
    }
  }
  return []
}

export class CogneeMemory implements MemoryBackend {
  readonly id = 'cognee'
  private readonly base: string
  private timer: ReturnType<typeof setTimeout> | undefined
  private cognifying: Promise<void> | undefined

  constructor(private readonly options: {
    baseUrl: string
    dataset: string
    apiKey?: string | undefined
    recallSearchType?: SearchType
    cognifyDebounceMs?: number
    fetch?: FetchLike | undefined
    onError?: (error: unknown) => void
  }) {
    this.base = `${options.baseUrl.replace(/\/+$/, '')}/api/v1`
  }

  private get headers(): Record<string, string> {
    return this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}
  }

  private get fetch(): FetchLike {
    return this.options.fetch ?? defaultFetch()
  }

  async retain(items: readonly MemoryItem[], signal?: AbortSignal): Promise<void> {
    const form = new FormData()
    form.append('datasetName', this.options.dataset)
    for (const item of items) {
      const header = [item.kind && `[${item.kind}]`, item.timestamp && `(${item.timestamp})`, item.context && `context: ${item.context}`].filter(Boolean).join(' ')
      form.append('raw_data', header ? `${header}\n${item.content}` : item.content)
    }
    await requestJson(this.fetch, `${this.base}/add`, { headers: this.headers, form, signal })
    this.scheduleCognify()
  }

  private scheduleCognify(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.cognify().catch((error: unknown) => this.options.onError?.(error))
    }, this.options.cognifyDebounceMs ?? 5_000)
    this.timer.unref?.()
  }

  /** Build or extend the knowledge graph for everything added so far. */
  cognify(signal?: AbortSignal): Promise<void> {
    this.cognifying ??= requestJson<void>(this.fetch, `${this.base}/cognify`, {
      headers: this.headers,
      signal,
      json: { datasets: [this.options.dataset], run_in_background: true },
    }).finally(() => { this.cognifying = undefined })
    return this.cognifying
  }

  private async search(query: string, searchType: SearchType, topK: number, signal?: AbortSignal): Promise<string[]> {
    const response = await requestJson<SearchResponse>(this.fetch, `${this.base}/search`, {
      headers: this.headers,
      signal,
      json: { query, searchType, search_type: searchType, datasets: [this.options.dataset], topK, top_k: topK },
    })
    return textsOf(typeof response === 'object' && response && !Array.isArray(response) ? response.results : response)
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryHit[]> {
    const limit = options.limit ?? 8
    const texts = await this.search(query, this.options.recallSearchType ?? 'CHUNKS', limit, options.signal)
    return texts.slice(0, limit).map((content, index) => {
      const kind = /^\[(experience|fact|self|skill)\]/.exec(content)?.[1] as MemoryItem['kind']
      return { content, score: 1 / (1 + index * 0.15), source: this.id, kind }
    }).filter((h) => !options.kinds?.length || !h.kind || options.kinds.includes(h.kind))
  }

  async reflect(query: string, signal?: AbortSignal): Promise<Reflection | undefined> {
    const texts = await this.search(query, 'GRAPH_COMPLETION', 10, signal)
    const answer = texts.join('\n').trim()
    return answer ? { answer, source: this.id } : undefined
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      await requestJson(this.fetch, `${this.options.baseUrl.replace(/\/+$/, '')}/health`, { headers: this.headers, signal })
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
  }
}

export function apply(ctx: Context, config: Config): void {
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined
  const logger = ctx.logger?.('memory-cognee')
  const backend = new CogneeMemory({ ...config, apiKey, onError: (e) => logger?.warn(`cognify failed: ${String(e)}`) })
  const unregister = ctx.memory.register(backend)
  ctx.effect(() => () => { backend.dispose(); unregister() }, 'memory-cognee.register')
}
