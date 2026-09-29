/**
 * Autonomy system prompt. Adds two sections to the system prompt:
 *
 * - `autonomy:constitution` — fixed rules for the autonomous agent (protected
 *   core; the agent cannot edit it), filled with live facts: identity, active
 *   goals, kill-switch state.
 * - `autonomy:learned` — guidelines the agent proposes while chatting
 *   (`prompt_propose`). Each change needs owner approval, is screened so it
 *   cannot weaken the safety core, and is versioned (`prompt_revert`).
 *
 * ```yaml
 * - id: autonomy-prompt
 *   name: '@deepseek-ai/dsh-autonomy-prompt'
 *   config:
 *     path: ~/.dsh/autonomy/guidelines.json
 * ```
 *
 * @module @deepseek-ai/dsh-autonomy-prompt
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-autonomy-core'
import { homedir } from 'node:os'
import { renderConstitution } from './constitution.ts'
import type { ConstitutionFacts } from './constitution.ts'
import { GuidelineStore } from './guidelines.ts'
import type { Proposal } from './guidelines.ts'

export * from './constitution.ts'
export * from './guidelines.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    guidelines: GuidelineStore
  }
}

export const name = 'autonomy-prompt'
export const inject = ['autonomy', 'systemPrompt']

export interface Config {
  /** Where learned guidelines persist; omitted = in-memory. */
  path?: string | undefined
  maxGuidelines: number
  maxChars: number
}

export const Config: z<Config> = z.object({
  path: z.string().description('Where learned guidelines persist; omitted = in-memory.'),
  maxGuidelines: z.natural().default(40),
  maxChars: z.natural().default(400),
}) as z<Config>

interface GoalsLike { goals: { list(filter: { status: string[] }): { title: string, priority: number }[] } }

export async function apply(ctx: Context, config: Config): Promise<void> {
  const store = new GuidelineStore({
    path: config.path?.replace(/^~(?=\/|$)/, homedir()),
    limits: { maxGuidelines: config.maxGuidelines, maxChars: config.maxChars },
  })
  await store.load()
  ctx.provide('guidelines', store)

  let facts: ConstitutionFacts = { name: 'dsh', mission: 'help your owner.', values: [], killSwitchEngaged: false, activeGoals: [] }
  const refresh = async (): Promise<void> => {
    const id = await ctx.autonomy.identity.identity()
    const exec = ctx.get('executive') as GoalsLike | undefined
    facts = {
      name: id.name,
      mission: id.mission,
      values: id.values,
      killSwitchEngaged: ctx.autonomy.killSwitch.engaged,
      activeGoals: exec?.goals.list({ status: ['active'] }).sort((a, b) => b.priority - a.priority).slice(0, 5).map((g) => g.title) ?? [],
    }
  }
  await refresh()

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'autonomy:constitution',
    order: ctx.systemPrompt.getSectionOrder('AUTONOMY'),
    interpolate: false,
    text: () => {
      void refresh().catch(() => {}) // next assembly sees fresh facts
      return renderConstitution({ ...facts, killSwitchEngaged: ctx.autonomy.killSwitch.engaged })
    },
  }))
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'autonomy:learned',
    order: ctx.systemPrompt.getSectionOrder('AUTONOMY_LEARNED'),
    interpolate: false,
    text: () => store.render(),
  }))

  void ctx.plugin({
    name: 'autonomy-prompt-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      const out = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
      const render = (_a: unknown, v: { text: string }) => [{ type: 'text' as const, text: v.text }]

      ctx.tools.register(defineTool({
        name: 'prompt_guidelines',
        description: 'Show your learned guidelines and their version history.',
        parameters: {},
        output: { schema: out, render },
        async execute() {
          const hist = store.history.slice(-10).map((v) => `v${v.version} ${v.at.slice(0, 10)} ${v.change}`).join('\n')
          return { text: `${store.render() || 'No learned guidelines yet.'}\n\nHistory:\n${hist}` }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'prompt_propose',
        description: 'Improve your own instructions. When your owner corrects you, states a preference, or a task teaches you '
          + 'something that should change how you work every time, propose a short guideline (add, replace or remove). '
          + 'Your owner approves each change. Guidelines cannot weaken your safety rules.',
        parameters: {
          op: { type: 'string', required: true, enum: ['add', 'replace', 'remove'] },
          id: { type: 'string', description: 'Guideline id for replace / remove.' },
          text: { type: 'string', description: 'The guideline, one imperative sentence or two.' },
          rationale: { type: 'string', required: true, description: 'What happened that makes this worth keeping.' },
          source: { type: 'string', description: 'e.g. "owner correction", "task lesson", "owner preference".' },
        },
        output: { schema: out, render },
        async execute(args) {
          const p: Proposal = args.op === 'add'
            ? { op: 'add', text: args.text ?? '', rationale: args.rationale, source: args.source }
            : args.op === 'replace'
              ? { op: 'replace', id: args.id ?? '', text: args.text ?? '', rationale: args.rationale, source: args.source }
              : { op: 'remove', id: args.id ?? '', rationale: args.rationale }
          const reason = store.check(p)
          if (reason) {
            await ctx.autonomy.audit.record('agent', 'guideline-refused', { ...p, reason })
            return { text: `Refused: ${reason}.` }
          }
          const v = await store.apply(p)
          await ctx.autonomy.audit.record('agent', 'guideline-changed', { ...p, version: v.version })
          return { text: `Applied (${v.change}); guidelines are now v${v.version}. They take effect from the next turn.` }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'prompt_revert',
        description: 'Revert your learned guidelines to an earlier version.',
        parameters: { version: { type: 'integer', required: true } },
        output: { schema: out, render },
        async execute(args) {
          const v = await store.revert(args.version)
          await ctx.autonomy.audit.record('agent', 'guideline-changed', { revert: args.version, version: v.version })
          return { text: `Reverted; guidelines are now v${v.version}.` }
        },
      }))
    },
  })
}
