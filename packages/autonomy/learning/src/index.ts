/**
 * Learning and growth. Provides `ctx.learning` (skill optimizer, experiment
 * runner, capability registry) and the tools the agent uses to experiment and
 * to grow new capabilities. Experiments and capability tests run on the
 * agent's own computer (`@deepseek-ai/dsh-agent-computer`) when it is mounted.
 *
 * ```yaml
 * - id: learning
 *   name: '@deepseek-ai/dsh-learning'
 *   config:
 *     skillsDir: ~/.dsh/skills
 * ```
 *
 * @module @deepseek-ai/dsh-learning
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-autonomy-core'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CapabilityRegistry } from './capability.ts'
import { parseMetric, runExperiment } from './experiment.ts'
import { optimizeSkill } from './skillopt.ts'

export * from './capability.ts'
export * from './experiment.ts'
export * from './skillopt.ts'

/** The slice of the agent computer this package needs (kept structural to avoid a hard dependency). */
export interface ComputerLike {
  exec(command: string, options?: { timeoutMs?: number }): Promise<{ code: number, stdout: string, stderr: string }>
  writeFile(path: string, content: string): Promise<void>
}

export interface LearningService {
  capabilities: CapabilityRegistry
  optimizeSkill: typeof optimizeSkill
  runExperiment: typeof runExperiment
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learning: LearningService
  }
}

export const name = 'learning'
export const inject = ['autonomy']

export interface Config {
  skillsDir: string
  scriptsDir: string
  maxTrials: number
  trialTimeoutMs: number
}

export const Config: z<Config> = z.object({
  skillsDir: z.string().default('~/.dsh/skills'),
  scriptsDir: z.string().default('~/.dsh/autonomy/bin'),
  maxTrials: z.natural().default(30),
  trialTimeoutMs: z.natural().default(300_000),
}) as z<Config>

const expand = (p: string): string => p.replace(/^~(?=\/|$)/, homedir())

export function apply(ctx: Context, config: Config): void {
  const computer = (): ComputerLike | undefined => ctx.get('agentComputer') as ComputerLike | undefined
  const capabilities = new CapabilityRegistry({
    skillsDir: expand(config.skillsDir),
    scriptsDir: expand(config.scriptsDir),
    async runTest(command, files) {
      const pc = computer()
      if (!pc) throw new Error('capability tests need the agent computer plugin')
      const root = `/home/agent/.capability-tests/${Date.now()}`
      for (const [rel, content] of Object.entries(files)) await pc.writeFile(join(root, rel), content)
      const r = await pc.exec(`cd ${root} && ${command}`, { timeoutMs: config.trialTimeoutMs })
      return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}` }
    },
  })
  ctx.provide('learning', { capabilities, optimizeSkill, runExperiment })
  void ctx.plugin({ name: 'learning-tools', inject: ['tools'], apply: (ctx: Context) => registerTools(ctx, capabilities, computer, config) })
}

const textOut = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
const render = (_a: unknown, v: { text: string }) => [{ type: 'text' as const, text: v.text }]

function registerTools(ctx: Context, capabilities: CapabilityRegistry, computer: () => ComputerLike | undefined, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'experiment_run',
    description: 'Run a controlled experiment on your own computer: each variant is a shell command that prints '
      + '"metric=<number>". Variants run interleaved for several trials and are compared statistically. '
      + 'Use this instead of trusting a single run.',
    parameters: {
      hypothesis: { type: 'string', required: true },
      variants: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, command: { type: 'string', required: true } } },
      },
      trials: { type: 'integer', description: 'Trials per variant (default 5).' },
      metric: { type: 'string', description: 'Metric name printed as name=<number> (default "metric").' },
      higherIsBetter: { type: 'boolean', description: 'Default true.' },
    },
    output: { schema: textOut, render },
    async execute(args, exec) {
      const pc = computer()
      if (!pc) throw new Error('experiments need the agent computer plugin')
      const commands = new Map(args.variants.map((v) => [v.name, v.command]))
      const result = await runExperiment({
        hypothesis: args.hypothesis,
        variants: [...commands.keys()],
        trials: Math.min(config.maxTrials, Math.max(2, args.trials ?? 5)),
        higherIsBetter: args.higherIsBetter ?? true,
        signal: exec.signal,
        async trial(variant) {
          const r = await pc.exec(commands.get(variant)!, { timeoutMs: config.trialTimeoutMs })
          return r.code === 0 ? parseMetric(r.stdout, args.metric ?? 'metric') : undefined
        },
      })
      const table = result.variants.map((v) => `${v.name}: mean ${v.mean.toFixed(4)} ± ${v.stdev.toFixed(4)} (n=${v.n}, failed ${v.failures})`)
      return { text: [result.conclusion, ...table].join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capability_propose',
    description: 'Propose a new capability for yourself: a reusable skill (instructions in SKILL.md) or a helper '
      + 'script. It must be tested and then approved by your owner before it is installed.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['skill', 'script'] },
      name: { type: 'string', required: true, description: 'kebab-case' },
      description: { type: 'string', required: true },
      content: { type: 'string', required: true },
      rationale: { type: 'string', required: true, description: 'Why you need it; what gap it fills.' },
      test: { type: 'string', description: 'Shell command (run next to the file) that exits 0 when it works.' },
    },
    output: { schema: textOut, render },
    async execute(args) {
      const p = capabilities.propose({ kind: args.kind as 'skill', name: args.name, description: args.description, content: args.content, rationale: args.rationale, test: args.test })
      return { text: `Proposal ${p.id} (${p.kind} ${p.name}) recorded. Next: capability_test.` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capability_test',
    description: 'Test a capability proposal on your own computer.',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: textOut, render },
    async execute(args) {
      const p = await capabilities.test(args.id)
      return { text: `${p.name}: ${p.status}\n${p.testOutput ?? ''}`.trim() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capability_install',
    description: 'Install a tested capability. This is a high-risk action and requires your owner\'s approval.',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: textOut, render },
    async execute(args) {
      const { proposal, path } = await capabilities.install(args.id)
      await ctx.autonomy.audit.record('agent', 'capability-installed', { id: proposal.id, name: proposal.name, kind: proposal.kind, path })
      return { text: `Installed ${proposal.kind} ${proposal.name} at ${path}.` }
    },
  }))
}
