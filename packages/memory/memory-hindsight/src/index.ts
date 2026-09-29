/**
 * Hindsight backend (https://github.com/vectorize-io/hindsight). Hindsight
 * extracts facts, entities, and temporal links from what it retains, recalls
 * with parallel semantic / keyword / graph / temporal search, and can reflect
 * to synthesize an answer. Runs as a separate server (Docker, pip, or
 * Hindsight Cloud); this plugin talks to its REST API.
 *
 * ```yaml
 * - id: memory-hindsight
 *   name: '@deepseek-ai/dsh-memory-hindsight'
 *   config:
 *     baseUrl: http://127.0.0.1:8888
 *     bank: primary            # one bank per agent identity
 *     apiKeyEnv: HINDSIGHT_API_KEY   # only for Hindsight Cloud
 * ```
 *
 * @module @deepseek-ai/dsh-memory-hindsight
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defaultFetch, requestJson } from '@deepseek-ai/dsh-memory'
import type { FetchLike, MemoryBackend, MemoryHit, MemoryItem, RecallOptions, Reflection } from '@deepseek-ai/dsh-memory'

export const name = 'memory-hindsight'
export const inject = ['memory']

export interface Config {
  /** Hindsight server URL. */
  baseUrl: string
  /** Memory bank; one per agent identity. */
  bank: string
  /** Namespace that holds the bank. */
  namespace: string
  /** Environment variable holding a Hindsight Cloud API key. */
  apiKeyEnv?: string | undefined
  /** Test seam. */
  fetch?: FetchLike | undefined
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://127.0.0.1:8888'),
  bank: z.string().default('primary').description('Memory bank; one per agent identity.'),
  namespace: z.string().default('default'),
  apiKeyEnv: z.string().description('Environment variable holding a Hindsight Cloud API key.'),
}) as z<Config>

interface RecallResponse {
  results?: { text?: string, content?: string, score?: number, relevance?: number, type?: string, fact_type?: string, occurred_start?: string, mentioned_at?: string }[]
}

interface ReflectResponse {
  text?: string
  answer?: string
}

/** Hindsight's memory types mapped onto the harness's kinds. */
const KIND_OF: Record<string, MemoryItem['kind']> = {
  world: 'fact',
  experience: 'experience',
  agent: 'experience',
  opinion: 'self',
  observation: 'fact',
}

export class HindsightMemory implements MemoryBackend {
  readonly id = 'hindsight'
  private readonly root: string

  constructor(private readonly options: { baseUrl: string, bank: string, namespace?: string, apiKey?: string | undefined, fetch?: FetchLike | undefined }) {
    const base = options.baseUrl.replace(/\/+$/, '')
    this.root = `${base}/v1/${encodeURIComponent(options.namespace ?? 'default')}/banks/${encodeURIComponent(options.bank)}`
  }

  private get headers(): Record<string, string> {
    return this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}
  }

  private get fetch(): FetchLike {
    return this.options.fetch ?? defaultFetch()
  }

  async retain(items: readonly MemoryItem[], signal?: AbortSignal): Promise<void> {
    await requestJson(this.fetch, `${this.root}/memories`, {
      headers: this.headers,
      signal,
      json: {
        items: items.map((i) => ({
          content: i.content,
          ...i.context || i.kind ? { context: [i.kind && `kind: ${i.kind}`, i.context].filter(Boolean).join('; ') } : {},
          ...i.timestamp ? { timestamp: i.timestamp } : {},
        })),
        async: true,
      },
    })
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryHit[]> {
    const response = await requestJson<RecallResponse>(this.fetch, `${this.root}/memories/recall`, {
      headers: this.headers,
      signal: options.signal,
      json: { query, max_tokens: 4096 },
    })
    const results = response?.results ?? []
    const hits = results.flatMap((r, index): MemoryHit[] => {
      const content = (r.text ?? r.content ?? '').trim()
      if (!content) return []
      const type = r.fact_type ?? r.type
      const kind = type ? KIND_OF[type] : undefined
      // Hindsight returns ranked results; synthesize a score from rank when absent.
      const score = r.score ?? r.relevance ?? 1 / (1 + index * 0.15)
      return [{ content, score, source: this.id, kind, timestamp: r.occurred_start ?? r.mentioned_at }]
    })
    const filtered = options.kinds?.length ? hits.filter((h) => !h.kind || options.kinds!.includes(h.kind)) : hits
    return filtered.slice(0, options.limit ?? 8)
  }

  async reflect(query: string, signal?: AbortSignal): Promise<Reflection | undefined> {
    const response = await requestJson<ReflectResponse>(this.fetch, `${this.root}/reflect`, {
      headers: this.headers,
      signal,
      json: { query },
    })
    const answer = (response?.text ?? response?.answer ?? '').trim()
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
}

export function apply(ctx: Context, config: Config): void {
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined
  const backend = new HindsightMemory({ ...config, apiKey })
  const unregister = ctx.memory.register(backend)
  ctx.effect(() => unregister, 'memory-hindsight.register')
}
