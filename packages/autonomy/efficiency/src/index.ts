/**
 * Efficiency. Three independent features, each on by default and switchable:
 *
 * - `toolSearch` — a `tool_search` tool: ranks every available tool for a
 *   described need and returns calibrated probabilities (or "no tool
 *   needed"). A model-backed chooser can be plugged in via
 *   `ctx.efficiency.setChooser()`.
 * - `compression` — shrinks long output from noisy tools (shells, command
 *   runners, fetchers) before the model sees it.
 * - `journal` — records every model call and tool call with duration, tokens
 *   and cost; `run_journal` replays the timeline and summarises spending.
 *   Token and dollar usage are also charged to the autonomy budget if
 *   `@deepseek-ai/dsh-autonomy-core` is loaded.
 *
 * ```yaml
 * - id: efficiency
 *   name: '@deepseek-ai/dsh-efficiency'
 *   config:
 *     journal: { path: ~/.dsh/autonomy/journal.jsonl, prices: { 'deepseek-*': { input: 0.28, output: 0.42 } } }
 * ```
 *
 * @module @deepseek-ai/dsh-efficiency
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { compress } from './compress.ts'
import { costOf, Journal, priceFor } from './journal.ts'
import type { Price } from './journal.ts'
import { decide, ToolIndex } from './rank.ts'
import type { Chooser, Decision } from './rank.ts'

export * from './compress.ts'
export * from './journal.ts'
export * from './rank.ts'

export interface EfficiencyService {
  /** Index of the currently visible tools (rebuilt when tools change). */
  index(): ToolIndex
  decide(query: string, signal?: AbortSignal): Promise<Decision>
  /** Plug in a model-backed chooser; pass undefined to return to BM25. */
  setChooser(chooser: Chooser | undefined): void
  journal: Journal
  /** Id grouping journal entries; call newRun() to start a fresh one. */
  run: string
  newRun(label?: string): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    efficiency: EfficiencyService
  }
}

export const name = 'efficiency'

export interface Config {
  /** Ranked tool search with calibrated probabilities (`tool_search`). */
  toolSearch: {
    /** Offer the `tool_search` tool. */
    enabled: boolean
    /** How many tools a search returns. */
    k: number
    /** Below this top probability the answer is "no tool needed". */
    threshold: number
  }
  /** Shrinking long output from noisy tools before the model sees it. */
  compression: {
    /** Compress output at all. */
    enabled: boolean
    /** Tool-name patterns whose output may be compressed; file reads never are. */
    tools: string[]
    /** Output shorter than this is left alone, in characters. */
    minChars: number
    /** Target length after compression, in characters. */
    maxChars: number
  }
  /** Replayable journal of model and tool calls with per-call cost. */
  journal: {
    /** Record the journal. */
    enabled: boolean
    /** JSONL file the journal appends to; omitted = in-memory. */
    path?: string | undefined
    /** Dollar prices per million tokens, keyed by model pattern (for example `deepseek-*`). */
    prices: Record<string, Price>
  }
}

const price = z.object({ input: z.number().required(), output: z.number().required(), cacheRead: z.number() })

export const Config: z<Config> = z.object({
  toolSearch: z.object({
    enabled: z.boolean().default(true),
    k: z.natural().default(20),
    threshold: z.number().min(0).max(1).default(0.35),
  }).default({ enabled: true, k: 20, threshold: 0.35 }),
  compression: z.object({
    enabled: z.boolean().default(true),
    tools: z.array(z.string()).default(['bash', 'pwsh', 'computer_exec', '*_exec', 'job_*', 'jobs_*', 'web_fetch', 'experiment_run'])
      .description('Tool-name globs whose output is compressed. File reads are excluded on purpose (exact text matters for edits).'),
    minChars: z.natural().default(2000),
    maxChars: z.natural().default(12_000),
  }).default({ enabled: true, tools: ['bash', 'pwsh', 'computer_exec', '*_exec', 'job_*', 'jobs_*', 'web_fetch', 'experiment_run'], minChars: 2000, maxChars: 12_000 }),
  journal: z.object({
    enabled: z.boolean().default(true),
    path: z.string().description('JSONL file; omitted = in-memory only.'),
    prices: z.dict(price).default({}).description('USD per million tokens by model glob, e.g. "deepseek-*".'),
  }).default({ enabled: true, prices: {} }),
}) as z<Config>

const glob = (pattern: string): RegExp => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)

interface BudgetLike { budget: { charge(resource: 'tokens' | 'usd' | 'actions', amount: number): void } }

export function apply(ctx: Context, config: Config): void {
  let chooser: Chooser | undefined
  let cached: ToolIndex | undefined
  const journal = new Journal({ path: config.journal.path?.replace(/^~(?=\/|$)/, homedir()) })
  void journal.load()

  const service: EfficiencyService = {
    index() {
      if (!cached) {
        const tools = ctx.get('tools') as { schemas(): { name: string, description?: string }[] } | undefined
        cached = new ToolIndex((tools?.schemas() ?? []).filter((t) => t.name !== 'tool_search').map((t) => ({ name: t.name, description: t.description ?? '' })))
      }
      return cached
    },
    decide(query, signal) {
      return decide(service.index(), query, { k: config.toolSearch.k, threshold: config.toolSearch.threshold, ...chooser ? { chooser } : {}, ...signal ? { signal } : {} })
    },
    setChooser(next) { chooser = next },
    journal,
    run: randomUUID().slice(0, 8),
    newRun(label) {
      service.run = `${label ? `${label}-` : ''}${randomUUID().slice(0, 8)}`
      return service.run
    },
  }
  ctx.provide('efficiency', service)
  ctx.on('tools/change', () => { cached = undefined })

  // ── Compression ──────────────────────────────────────────────────────────
  const compressed = new Map<string, number>()
  if (config.compression.enabled) {
    const patterns = config.compression.tools.map(glob)
    ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
      if (!patterns.some((re) => re.test(exec.name))) return next()
      let before = 0
      let changed = false
      const content: ContentBlock[] = result.content.map((block) => {
        if (block.type !== 'text') return block
        const c = compress(block.text, { minChars: config.compression.minChars, maxChars: config.compression.maxChars })
        before += c.before
        if (!c.changed) return block
        changed = true
        return { ...block, text: c.text }
      })
      if (!changed) return next()
      compressed.set(String(exec.callId), before)
      return { kind: 'accept', content }
    })
  }

  // ── Journal ──────────────────────────────────────────────────────────────
  if (config.journal.enabled) {
    const charge = (tokens: number, usd: number | undefined) => {
      const core = ctx.get('autonomy') as BudgetLike | undefined
      if (!core) return
      core.budget.charge('tokens', tokens)
      if (usd) core.budget.charge('usd', usd)
    }
    ctx.on('llm/stream', async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
      const start = Date.now()
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
      let finish: string | undefined
      let error: string | undefined
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') {
            usage.inputTokens = chunk.usage.inputTokens
            usage.outputTokens = chunk.usage.outputTokens
            usage.cacheReadTokens = chunk.usage.cacheReadTokens ?? 0
          } else if (chunk.type === 'finish') finish = typeof chunk.reason === 'string' ? chunk.reason : chunk.reason.kind
          yield chunk
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        throw e
      } finally {
        const costUsd = costOf(usage, priceFor(options.model, config.journal.prices))
        charge(usage.inputTokens + usage.outputTokens, costUsd)
        void journal.record({ kind: 'llm', run: service.run, at: new Date(start).toISOString(), model: options.model, durationMs: Date.now() - start, ...usage, costUsd, finish, error }).catch(() => {})
      }
    })
    const started = new Map<string, number>()
    ctx.on('tools/execute', async (exec, next) => {
      started.set(String(exec.callId), Date.now())
      return next()
    })
    ctx.on('tools/result', (exec, result) => {
      const id = String(exec.callId)
      const t0 = started.get(id)
      started.delete(id)
      const from = compressed.get(id)
      compressed.delete(id)
      const outputChars = result.content.reduce((s, b) => s + (b.type === 'text' ? b.text.length : 0), 0)
      void journal.record({
        kind: 'tool', run: service.run, at: new Date().toISOString(), tool: exec.name, callId: id,
        durationMs: t0 === undefined ? undefined : Date.now() - t0, isError: result.isError, args: exec.arguments, outputChars,
        ...from !== undefined ? { compressedFrom: from } : {},
      }).catch(() => {})
      return undefined
    })
  }

  // ── Tools ────────────────────────────────────────────────────────────────
  void ctx.plugin({
    name: 'efficiency-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      const out = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
      const render = (_a: unknown, v: { text: string }) => [{ type: 'text' as const, text: v.text }]
      if (config.toolSearch.enabled) {
        ctx.tools.register(defineTool({
          name: 'tool_search',
          description: 'Find the right tool for a need when you are not sure which one fits. Returns ranked tools with probabilities, '
            + 'or says no tool is needed. Answer directly when no tool is needed.',
          parameters: { need: { type: 'string', required: true, description: 'What you want to do, in plain words.' } },
          output: { schema: out, render },
          async execute(args, exec) {
            const d = await service.decide(args.need, exec.signal)
            const rows = Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5)
              .map(([name, p]) => `  ${name.padEnd(28)} ${(p * 100).toFixed(0)}%${name === 'none' ? '' : ` — ${service.index().doc(name)?.description.split('\n')[0]?.slice(0, 100) ?? ''}`}`)
            return { text: `${d.abstained ? `No confident pick: ${d.reason}.` : `Use ${d.choice}: ${d.reason}.`}\n${rows.join('\n')}` }
          },
        }))
      }
      if (config.journal.enabled) {
        ctx.tools.register(defineTool({
          name: 'run_journal',
          description: 'Replay what happened in a run (model and tool calls in order) and what it cost.',
          parameters: {
            run: { type: 'string', description: 'Run id; default the current run.' },
            timeline: { type: 'boolean', description: 'Include the full timeline (default false: summary only).' },
          },
          output: { schema: out, render },
          async execute(args) {
            const run = args.run ?? service.run
            const s = journal.summary(run)
            const models = Object.entries(s.byModel).map(([m, v]) => `  ${m}: ${v.calls} calls, ${v.tokens} tokens, $${v.costUsd.toFixed(4)}`)
            const tools = Object.entries(s.byTool).sort((a, b) => b[1].calls - a[1].calls).slice(0, 10).map(([t, v]) => `  ${t}: ${v.calls}${v.errors ? ` (${v.errors} failed)` : ''}`)
            return {
              text: [
                `Run ${run}: ${s.llmCalls} model calls, ${s.toolCalls} tool calls (${s.toolErrors} failed), ${s.inputTokens} in / ${s.outputTokens} out tokens, $${s.costUsd.toFixed(4)}${s.unpricedCalls ? ` (+${s.unpricedCalls} unpriced calls)` : ''}. Compression saved ${s.savedChars} chars.`,
                ...models.length ? ['Models:', ...models] : [],
                ...tools.length ? ['Tools:', ...tools] : [],
                ...args.timeline ? ['Timeline:', journal.format(run)] : [],
                `Other runs: ${journal.runs().filter((r) => r !== run).slice(-5).join(', ') || 'none'}`,
              ].join('\n'),
            }
          },
        }))
      }
    },
  })
}
