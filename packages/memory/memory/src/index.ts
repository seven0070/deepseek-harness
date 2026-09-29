/**
 * Memory seam. Provides `ctx.memory` — one retain / recall / reflect service
 * over every registered backend — plus the built-in local backend and the
 * model tools. Service-backed engines (Hindsight, Cognee) are separate
 * plugins that register onto this seam; with none installed the agent still
 * remembers through the local store.
 *
 * ```yaml
 * - id: memory
 *   name: '@deepseek-ai/dsh-memory'
 *   config:
 *     local: true
 *     localPath: ~/.dsh/memory/primary.jsonl
 * ```
 *
 * @module @deepseek-ai/dsh-memory
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { LocalMemory } from './local.ts'
import { MemoryService } from './service.ts'
import { VaultMemory } from './vault.ts'
import { MEMORY_KINDS } from './types.ts'
import type { MemoryKind } from './types.ts'

export * from './types.ts'
export * from './service.ts'
export * from './local.ts'
export * from './http.ts'
export * from './vault.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

export const name = 'memory'

export interface Config {
  /** Keep the built-in local store as a floor. */
  local: boolean
  /** JSON Lines file for the local store; omitted = in-memory only. */
  localPath?: string | undefined
  /** Folder of Markdown notes (Obsidian-compatible) used as a two-way memory backend. */
  vault?: string | undefined
  /** Per-backend deadline for one operation. */
  timeoutMs: number
  /** Backend id → trust multiplier when merging. */
  weights: Record<string, number>
  /** Expose memory_* tools to the model. */
  tools: boolean
}

export const Config: z<Config> = z.object({
  local: z.boolean().default(true).description('Keep the built-in local store as a floor.'),
  localPath: z.string().description('JSON Lines file for the local store; omitted = in-memory only.'),
  vault: z.string().description('Folder of Markdown notes (Obsidian-compatible) used as a two-way memory backend.'),
  timeoutMs: z.natural().default(10_000).description('Per-backend deadline for one operation.'),
  weights: z.dict(z.number().min(0)).default({}).description('Backend id → trust multiplier when merging.'),
  tools: z.boolean().default(true).description('Expose memory_* tools to the model.'),
}) as z<Config>

const kindParam = { type: 'string', enum: [...MEMORY_KINDS] } as const

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger?.('memory')
  const service = new MemoryService({
    timeoutMs: config.timeoutMs,
    weights: config.weights,
    onError: (backend, operation, error) => logger?.warn(`${backend} ${operation} failed: ${String((error as Error)?.message ?? error)}`),
  })
  if (config.local) {
    const path = config.localPath?.replace(/^~(?=\/|$)/, homedir())
    service.register(new LocalMemory({ path }))
  }
  if (config.vault) service.register(new VaultMemory({ dir: config.vault.replace(/^~(?=\/|$)/, homedir()) }))
  ctx.provide('memory', service)
  // Tools mount only once a tool registry exists, so the service itself has
  // no hard dependency on it.
  if (config.tools) void ctx.plugin({ name: 'memory-tools', inject: ['tools'], apply: (ctx: Context) => registerTools(ctx, service) })
}

function registerTools(ctx: Context, service: MemoryService): void {
  ctx.tools.register(defineTool({
    name: 'memory_retain',
    description: 'Save something worth remembering beyond this session: a fact about the world or user, '
      + 'an experience (what you did and how it turned out), something about yourself, or a skill that worked.',
    parameters: {
      content: { type: 'string', required: true, description: 'One self-contained memory.' },
      kind: { ...kindParam, description: 'experience | fact | self | skill.' },
      context: { type: 'string', description: 'Where it came from, e.g. the task.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { failed: { type: 'array', required: true, items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: value.failed.length ? `Saved (unavailable: ${value.failed.join(', ')})` : 'Saved.' }],
    },
    async execute(args, exec) {
      const failed = await service.retain([{ content: args.content, kind: args.kind as MemoryKind | undefined, context: args.context }], exec.signal)
      return { failed }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Search your long-term memory before acting on anything you may have seen or learned before.',
    parameters: {
      query: { type: 'string', required: true },
      kinds: { type: 'array', items: kindParam, description: 'Restrict to these kinds.' },
      limit: { type: 'integer', description: 'Maximum results (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                score: { type: 'number', required: true },
                source: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.memories.length
          ? value.memories.map((m) => `- (${m.score.toFixed(2)}, ${m.source}) ${m.content}`).join('\n')
          : 'No relevant memories.',
      }],
    },
    async execute(args, exec) {
      const { hits } = await service.recall(args.query, {
        limit: args.limit ?? 8,
        kinds: args.kinds as MemoryKind[] | undefined,
        signal: exec.signal,
      })
      return { memories: hits.map(({ content, score, source }) => ({ content, score: Math.round(score * 1000) / 1000, source })) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_reflect',
    description: 'Think over everything you remember about a topic and get a synthesized answer, '
      + 'rather than a list of raw memories.',
    parameters: { query: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string', required: true }, source: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.answer }],
    },
    async execute(args, exec) {
      return await service.reflect(args.query, exec.signal)
    },
  }))
}
