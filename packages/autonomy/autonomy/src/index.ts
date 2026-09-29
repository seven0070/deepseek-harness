/**
 * One-switch autonomy bundle. Mounts the autonomy plugins together with a
 * shared state directory and wires them to each other and to the model:
 *
 * - safety core (always), memory, executive, efficiency, autonomy prompt,
 *   workflows and learning (on by default), evolution and the subjectivity
 *   research layer (off by default);
 * - the executive gets a model-backed planner and step delegate;
 * - workflow `agent` nodes use the same delegate;
 * - the tool ranker narrows the tool list the planner sees;
 * - executed steps feed the subjectivity layer when it is enabled.
 *
 * ```yaml
 * - id: autonomy
 *   name: '@deepseek-ai/dsh-autonomy'
 *   config:
 *     stateDir: ~/.dsh/autonomy
 *     model: { provider: deepseek, model: deepseek-chat }   # default: the agent's default model
 *     autorun: false
 * ```
 *
 * Every sub-plugin keeps its own config under its key (`core`, `memory`,
 * `executive`, …), so anything can still be tuned individually.
 *
 * @module @deepseek-ai/dsh-autonomy
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Core from '@deepseek-ai/dsh-autonomy-core'
import * as AutonomyPrompt from '@deepseek-ai/dsh-autonomy-prompt'
import * as Efficiency from '@deepseek-ai/dsh-efficiency'
import * as Evolution from '@deepseek-ai/dsh-evolution'
import * as Executive from '@deepseek-ai/dsh-executive'
import type { Goal } from '@deepseek-ai/dsh-executive'
import * as Learning from '@deepseek-ai/dsh-learning'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as Subjectivity from '@deepseek-ai/dsh-subjectivity'
import * as Workflows from '@deepseek-ai/dsh-workflows'
import { join } from 'node:path'
import { AutonomyControl } from './remote.ts'
import { makeAgentRunner, makeDelegate, makePlanner } from './brain.ts'
import type { Complete, ToolInfo } from './brain.ts'

export * from './brain.ts'
export { AutonomyControl } from './remote.ts'
export type * from './types.ts'

export const name = 'autonomy-bundle'

type Section = {
  /** Mount this part. */
  enabled: boolean
} & Record<string, unknown>

export interface Config {
  /** Shared state folder (identity, audit, memory, goals, guidelines, workflows, journal); omitted = <dsh home>/autonomy inside the app, in-memory elsewhere. */
  stateDir?: string | undefined
  /** Model for planning and delegated steps; omitted = the agent's default model. */
  model?: {
    /** Provider id, for example `deepseek-official`. */
    provider: string
    /** Model id at that provider. */
    model: string
  } | undefined
  /** Work through goals in the background. */
  autorun: boolean
  /** Tool turns per delegated step. */
  maxTurns: number
  /** How many ranked tools the planner sees. */
  plannerTools: number
  /** Safety core config (always mounted). */
  core: Record<string, unknown>
  /** Memory: local store plus optional backends. */
  memory: Section
  /** Executive loop config (always mounted). */
  executive: Record<string, unknown>
  /** Tool search, output compression and the cost journal. */
  efficiency: Section
  /** Constitution plus learned guidelines in the system prompt. */
  prompt: Section
  /** Agent-proposed workflows that run after owner review. */
  workflows: Section
  /** Skill optimisation, experiments and new capabilities. */
  learning: Section
  /** Sandboxed self-improvement (off by default). */
  evolution: Section
  /** Research-only measurement layer (off by default). */
  subjectivity: Section
  /** Serve the web client's Autonomy page (read-only snapshot plus owner decisions). */
  controlPage: boolean
}

const section = (enabled: boolean) => z.intersect([z.object({ enabled: z.boolean().default(enabled) }), z.dict(z.any())]).default({ enabled }) as unknown as z<Section>

export const Config: z<Config> = z.object({
  stateDir: z.string().description('Shared state folder (identity, audit, memory, goals, guidelines, workflows, journal); omitted = <dsh home>/autonomy inside the app, in-memory elsewhere.'),
  model: z.object({ provider: z.string(), model: z.string() }).description('Model for planning; default = agent default model.'),
  autorun: z.boolean().default(false).description('Work through goals in the background.'),
  maxTurns: z.natural().default(6).description('Tool turns per delegated step.'),
  plannerTools: z.natural().default(25).description('How many ranked tools the planner sees.'),
  core: z.dict(z.any()).default({}),
  memory: section(true),
  executive: z.dict(z.any()).default({}),
  efficiency: section(true),
  prompt: section(true),
  workflows: section(true),
  learning: section(true),
  evolution: section(false),
  subjectivity: section(false),
  controlPage: z.boolean().default(true).description('Serve the Autonomy page in the web client.'),
}) as unknown as z<Config>

interface LlmLike { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
interface ToolsLike {
  schemas(): { name: string, description?: string }[]
  execute(input: { signal: AbortSignal, callId: ReturnType<typeof ToolCallId>, name: string, arguments: unknown }): Promise<Parameters<typeof Executive.toActResult>[0]>
}

/** Collect a streamed completion into text. */
export async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && typeof chunk.reason !== 'string' && chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
  }
  return text
}

const INTERNAL = new Set(['tool_search', 'run_journal'])

export async function apply(ctx: Context, config: Config): Promise<void> {
  // Inside the app the Harness home is available: keep state there by default
  // so goals, memory and the audit log survive restarts. Elsewhere (tests,
  // embedding) an omitted stateDir stays in-memory.
  const home = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
  const dir = config.stateDir ?? home?.('autonomy')
  const at = (file: string) => (dir ? join(dir, file) : undefined)
  const strip = ({ enabled: _, ...rest }: Section) => rest
  const opt = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

  const mount = (plugin: object, cfg: object) => ctx.plugin(plugin as never, cfg as never)
  await mount(Core, opt({ stateDir: dir, ...config.core }))
  if (config.memory.enabled) await mount(Memory, opt({ localPath: at('memory.jsonl'), ...strip(config.memory) }))
  await mount(Executive, opt({ statePath: at('executive.json'), autorun: config.autorun, ...config.executive }))
  if (config.efficiency.enabled) await mount(Efficiency, { journal: opt({ path: at('journal.jsonl') }), ...strip(config.efficiency) })
  if (config.prompt.enabled) await mount(AutonomyPrompt, opt({ path: at('guidelines.json'), ...strip(config.prompt) }))
  if (config.workflows.enabled) await mount(Workflows, opt({ dir: at('workflows'), ...strip(config.workflows) }))
  if (config.learning.enabled) await mount(Learning, strip(config.learning))
  if (config.evolution.enabled) await mount(Evolution, strip(config.evolution))
  if (config.subjectivity.enabled) await mount(Subjectivity, { ...strip(config.subjectivity), enabled: true })
  if (config.controlPage) await ctx.plugin(AutonomyControl)

  // Research measurement: executed steps → agency indicator (read-only feed).
  ctx.inject(['executive', 'subjectivity'], (ctx) => {
    ctx.effect(() => ctx.executive.onStep((e) => ctx.subjectivity.recordAction(e.goal.id, true)))
  })

  // The brain: planner + delegate over the model, once a model and tools exist.
  ctx.inject(['executive', 'llm', 'tools'], (ctx) => {
    const llm = ctx.llm as unknown as LlmLike
    const tools = ctx.tools as unknown as ToolsLike
    const selection = (): { provider: string, model: string } => {
      if (config.model?.provider && config.model.model) return { provider: config.model.provider, model: config.model.model }
      const def = ctx.get('agentDefaultModel') as { currentSelection(): { provider: string, model: string } } | undefined
      if (def) return def.currentSelection()
      throw new Error('autonomy: no model configured (set model or agentDefaultModel)')
    }
    const complete: Complete = async ({ system, prompt, maxTokens, signal }) => {
      const { provider, model } = selection()
      return collectText(llm.stream({
        provider, model, system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] as GenerateOptions['messages'],
        ...maxTokens ? { maxTokens } : {},
        ...signal ? { signal } : {},
      }))
    }
    const available = (): ToolInfo[] => tools.schemas().filter((t) => !INTERNAL.has(t.name)).map((t) => ({ name: t.name, description: t.description ?? '' }))
    const ranked = (query: string): ToolInfo[] => {
      const all = available()
      const eff = ctx.get('efficiency') as Efficiency.EfficiencyService | undefined
      if (!eff || all.length <= config.plannerTools) return all
      const top = new Set(eff.index().search(query, config.plannerTools).map((r) => r.name))
      // Always keep memory / goal tools so the planner can use them.
      return all.filter((t) => top.has(t.name) || /^(memory_|belief_|computer_exec)/.test(t.name))
    }
    let n = 0
    const delegate = makeDelegate({
      complete,
      maxTurns: config.maxTurns,
      tools: (step: Executive.Step, goal: Goal) => ranked(`${goal.title} ${step.description}`),
      async callTool(name, args, signal) {
        return Executive.toActResult(await tools.execute({ signal, callId: ToolCallId(`auto-${Date.now().toString(36)}-${++n}`), name, arguments: args }))
      },
    })
    ctx.executive.setPlanner(makePlanner({ complete, tools: (goal) => ranked(`${goal.title} ${goal.successCriteria.join(' ')}`) }))
    ctx.executive.setDelegate(delegate)
    const wf = ctx.get('workflows') as Workflows.WorkflowService | undefined
    if (wf) wf.runAgent = makeAgentRunner(delegate)
    ctx.effect(() => () => {
      ctx.executive.setPlanner(undefined)
      ctx.executive.setDelegate(undefined)
      if (wf) wf.runAgent = undefined
    })
  })
}
