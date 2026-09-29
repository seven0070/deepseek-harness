/**
 * Executive core. Provides `ctx.executive` (the {@link ExecutiveLoop}) and the
 * tools the agent uses to manage its goals, plans, and beliefs. With
 * `autorun`, the loop runs in the background and works through goals on its
 * own — every action still passes the autonomy-core gate, and anything above
 * the auto-approve level waits in the approval queue.
 *
 * ```yaml
 * - id: executive
 *   name: '@deepseek-ai/dsh-executive'
 *   config:
 *     autorun: false        # true = work on goals in the background
 *     idleMs: 30000
 * ```
 *
 * @module @deepseek-ai/dsh-executive
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { readJson, writeJsonAtomic } from '@deepseek-ai/dsh-autonomy-core'
import type {} from '@deepseek-ai/dsh-memory'
import { homedir } from 'node:os'
import { ExecutiveLoop } from './loop.ts'
import type { ActResult, ExecutiveState } from './loop.ts'
import { makePlan, planOutcome } from './plan.ts'
import type { ToolAction } from './plan.ts'
import { band } from './world.ts'

export * from './goals.ts'
export * from './loop.ts'
export * from './plan.ts'
export * from './world.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    executive: ExecutiveLoop
  }
}

export const name = 'executive'
export const inject = ['autonomy']

export interface Config {
  statePath?: string | undefined
  autorun: boolean
  intervalMs: number
  idleMs: number
  tools: boolean
}

export const Config: z<Config> = z.object({
  statePath: z.string().description('JSON file for goals, plans, and beliefs; omitted = in-memory.'),
  autorun: z.boolean().default(false).description('Work through goals in the background.'),
  intervalMs: z.natural().default(1000),
  idleMs: z.natural().default(30_000),
  tools: z.boolean().default(true),
}) as z<Config>

/** Turn a tool runtime result into pass/fail, treating non-zero exit codes as failure. */
export function toActResult(result: ToolExecutionResult): ActResult {
  const text = result.content.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('\n').trim()
  if (result.isError) return { ok: false, text: text || result.error.message }
  const value = result.value as { exitCode?: unknown } | null
  const exit = value && typeof value === 'object' && typeof value.exitCode === 'number' ? value.exitCode : 0
  return { ok: exit === 0, text: text || JSON.stringify(result.value) }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const path = config.statePath?.replace(/^~(?=\/|$)/, homedir())
  const state = await readJson<ExecutiveState>(path)
  const loop = new ExecutiveLoop({
    core: ctx.autonomy,
    get memory() { return ctx.get('memory') },
    async act(action, callId, signal) {
      const tools = ctx.get('tools')
      if (!tools) return { ok: false, text: 'no tool runtime' }
      return toActResult(await tools.execute({ signal, callId: callId as never, name: action.tool, arguments: action.args }))
    },
    save: (s) => writeJsonAtomic(path, s),
  }, state)
  ctx.provide('executive', loop)

  if (config.autorun) {
    const logger = ctx.logger?.('executive')
    const controller = new AbortController()
    void loop.run({
      intervalMs: config.intervalMs,
      idleMs: config.idleMs,
      signal: controller.signal,
      onTick: (r) => { if (r.kind !== 'idle') logger?.info(JSON.stringify(r)) },
    }).catch((e: unknown) => logger?.warn(`executive loop ended: ${String(e)}`))
    ctx.effect(() => () => controller.abort(), 'executive.autorun')
  }

  if (config.tools) void ctx.plugin({ name: 'executive-tools', inject: ['tools'], apply: (ctx: Context) => registerTools(ctx, loop, () => writeJsonAtomic(path, loop.toJSON())) })
}

const textOut = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
const render = (_a: unknown, v: { text: string }) => [{ type: 'text' as const, text: v.text }]

function registerTools(ctx: Context, loop: ExecutiveLoop, save: () => Promise<void>): void {
  ctx.tools.register(defineTool({
    name: 'goal_add',
    description: 'Add a goal. Subgoals of an existing goal become active immediately; a new top-level goal you '
      + 'propose stays "proposed" until your owner accepts it.',
    parameters: {
      title: { type: 'string', required: true },
      successCriteria: { type: 'array', items: { type: 'string' }, description: 'How to tell it is done.' },
      parentId: { type: 'string' },
      priority: { type: 'integer' },
    },
    output: { schema: textOut, render },
    async execute(args) {
      const g = loop.goals.add('agent', { title: args.title, successCriteria: args.successCriteria ?? [], ...args.parentId ? { parentId: args.parentId } : {}, ...args.priority !== undefined ? { priority: args.priority } : {} })
      await save()
      return { text: `Goal ${g.id} (${g.status}): ${g.title}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'goal_list',
    description: 'List your goals and what you should work on next.',
    parameters: {},
    output: { schema: textOut, render },
    async execute() {
      const lines = loop.goals.list().map((g) => `${g.parentId ? '  ' : ''}[${g.status}] ${g.id} p${g.priority} ${g.title}`)
      const next = loop.goals.next()
      return { text: `${lines.join('\n') || 'No goals.'}\nNext: ${next ? `${next.id} ${next.title}` : 'nothing active'}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'goal_update',
    description: 'Update a goal: mark it done, failed, or blocked, change priority, or add a note.',
    parameters: {
      id: { type: 'string', required: true },
      status: { type: 'string', enum: ['active', 'blocked', 'done', 'failed', 'abandoned'] },
      priority: { type: 'integer' },
      note: { type: 'string' },
    },
    output: { schema: textOut, render },
    async execute(args) {
      const g = loop.goals.update('agent', args.id, {
        ...args.status ? { status: args.status as 'active' } : {},
        ...args.priority !== undefined ? { priority: args.priority } : {},
        ...args.note ? { note: args.note } : {},
      })
      await save()
      return { text: `Goal ${g.id} is ${g.status}.` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plan_set',
    description: 'Set or replace the plan for a goal: ordered steps with dependencies. A step may name a tool '
      + 'action to run and a check action that verifies it worked.',
    parameters: {
      goalId: { type: 'string', required: true },
      steps: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            description: { type: 'string', required: true },
            dependsOn: { type: 'array', items: { type: 'string' } },
            tool: { type: 'string', description: 'Tool to run for this step.' },
            args: { type: 'object', additionalProperties: true, description: 'Arguments for the tool.' },
            checkTool: { type: 'string', description: 'Tool whose success verifies the step.' },
            checkArgs: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    output: { schema: textOut, render },
    async execute(args) {
      if (!loop.goals.get(args.goalId)) throw new Error(`no goal ${args.goalId}`)
      const action = (tool?: string, a?: unknown): ToolAction | undefined => tool ? { tool, args: (a ?? {}) as Record<string, unknown> } : undefined
      const plan = makePlan(args.goalId, args.steps.map((s) => ({
        id: s.id,
        description: s.description,
        dependsOn: s.dependsOn ?? [],
        action: action(s.tool, s.args),
        check: action(s.checkTool, s.checkArgs),
      })))
      loop.setPlan(plan)
      await save()
      return { text: `Plan for ${args.goalId}: ${plan.steps.length} steps (revision ${loop.plans.get(args.goalId)!.revision}).` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plan_status',
    description: 'Show the plan and step progress for a goal.',
    parameters: { goalId: { type: 'string', required: true } },
    output: { schema: textOut, render },
    async execute(args) {
      const plan = loop.plans.get(args.goalId)
      if (!plan) return { text: 'No plan.' }
      return { text: [`Outcome: ${planOutcome(plan)}`, ...plan.steps.map((s) => `[${s.status}] ${s.id}: ${s.description}${s.lastError ? ` — ${s.lastError}` : ''}`)].join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'belief_observe',
    description: 'Update your world model with evidence for or against a statement. Reliability is how often '
      + 'this kind of source is right (0.5 useless … 0.99 near-certain). Use verified=true only after a direct check.',
    parameters: {
      statement: { type: 'string', required: true },
      supports: { type: 'boolean', required: true },
      source: { type: 'string', required: true },
      reliability: { type: 'number', required: true },
      verified: { type: 'boolean' },
    },
    output: { schema: textOut, render },
    async execute(args) {
      const b = loop.world.observe(args.statement, { source: args.source, supports: args.supports, reliability: args.reliability }, args.verified === undefined ? {} : { verified: args.verified })
      await save()
      return { text: `"${b.statement}": ${(b.confidence * 100).toFixed(0)}% (${band(b)}), ${b.evidence.length} evidence` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'belief_query',
    description: 'Ask your world model what you believe about something, with calibrated confidence. '
      + 'Say you are unsure when confidence is low; verify before acting on uncertain beliefs.',
    parameters: { query: { type: 'string', required: true } },
    output: { schema: textOut, render },
    async execute(args) {
      const hits = loop.world.query(args.query)
      const cal = loop.world.calibration()
      return {
        text: [
          ...hits.map((b) => `${(b.current * 100).toFixed(0)}% [${b.band}] ${b.statement}`),
          hits.length ? '' : 'No beliefs on this.',
          cal.resolved ? `Calibration: Brier ${cal.brier!.toFixed(3)} over ${cal.resolved}${cal.overconfident ? ' — you have been overconfident' : ''}` : '',
        ].filter(Boolean).join('\n'),
      }
    },
  }))
}
