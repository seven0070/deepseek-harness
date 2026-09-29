/**
 * Whole-system evolution (Helix). Provides `ctx.evolution` and tools to start
 * a Helix run, inspect candidates, and promote or roll back — promotion
 * always needs owner approval and never accepts a change to the protected
 * safety core.
 *
 * ```yaml
 * - id: evolution
 *   name: '@deepseek-ai/dsh-evolution'
 *   config:
 *     repoDir: .
 *     gates:
 *       - { name: typecheck, command: pnpm run typecheck }
 *       - { name: tests, command: pnpm vitest run }
 *     helix: { agent: { cli: claude } }   # passed through to helix.toml
 * ```
 *
 * @module @deepseek-ai/dsh-evolution
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-autonomy-core'
import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { evaluatorScript, helixCommand, parseHelixResult, toToml } from './helix.ts'
import type { TomlValue } from './helix.ts'
import { Evolution } from './promotion.ts'
import { LimitlessDriver } from './limitless.ts'
import type { Git } from './promotion.ts'

export * from './helix.ts'
export * from './promotion.ts'
export * from './limitless.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    evolution: Evolution
    evolutionDriver: LimitlessDriver
  }
}

export const name = 'evolution'
export const inject = ['autonomy']

export interface Gate { name: string, command: string, required?: boolean }

export interface Config {
  repoDir: string
  gates: Gate[]
  minScore: number
  helix: Record<string, TomlValue>
  evaluateTimeoutMs: number
  /** gated: single runs, protected core refused. limitless: endless generations, whole repo mutable, owner approval to promote. */
  mode: 'gated' | 'limitless'
  protectedCore: 'refuse' | 'owner-approval'
  maxGenerations: number
  cooldownMs: number
}

export const Config: z<Config> = z.object({
  repoDir: z.string().default('.'),
  gates: z.array(z.object({ name: z.string().required(), command: z.string().required(), required: z.boolean() })).default([
    { name: 'tests', command: 'pnpm vitest run' },
  ]),
  minScore: z.number().default(0),
  helix: z.dict(z.any()).default({}).description('Extra helix.toml keys, passed through.'),
  evaluateTimeoutMs: z.natural().default(1_800_000),
  mode: z.union(['gated', 'limitless']).default('gated'),
  protectedCore: z.union(['refuse', 'owner-approval']).description('Default: refuse in gated mode, owner-approval in limitless mode.'),
  maxGenerations: z.natural().default(0).description('0 = unlimited (limitless mode).'),
  cooldownMs: z.natural().default(60_000),
}) as z<Config>

const run = promisify(execFile)

export function apply(ctx: Context, config: Config, deps: { git?: Git } = {}): void {
  const repo = resolve(config.repoDir)
  const git: Git = deps.git ?? (async (args) => (await run('git', [...args], { cwd: repo, maxBuffer: 64 << 20 })).stdout)
  const script = evaluatorScript(config.gates)

  const evolution = new Evolution({
    git,
    protectedPatterns: ctx.autonomy.policy.protectedPatterns,
    minScore: config.minScore,
    protectedCore: config.protectedCore ?? (config.mode === 'limitless' ? 'owner-approval' : 'refuse'),
    stateFile: join(repo, '.helix', 'dsh-promotions.json'),
    async evaluate(branch) {
      if (deps.git) return undefined // injected git (tests): no real worktree
      const dir = await mkdtemp(join(tmpdir(), 'dsh-eval-'))
      try {
        await git(['worktree', 'add', '--detach', dir, branch])
        await writeFile(join(dir, '.dsh-evaluate.sh'), script, { mode: 0o755 })
        const { stdout } = await run('sh', ['.dsh-evaluate.sh'], { cwd: dir, timeout: config.evaluateTimeoutMs, maxBuffer: 64 << 20 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }))
        return parseHelixResult(stdout)?.score
      } finally {
        await git(['worktree', 'remove', '--force', dir]).catch(() => {})
        await rm(dir, { recursive: true, force: true })
      }
    },
  })
  ctx.provide('evolution', evolution)
  void evolution.load()

  const driver = new LimitlessDriver({
    evolution,
    maxGenerations: config.mode === 'limitless' ? config.maxGenerations : Math.max(1, config.maxGenerations),
    cooldownMs: config.cooldownMs,
    killSignal: ctx.autonomy.killSwitch.signal,
    async runGeneration(generation, signal) {
      const configPath = await prepare()
      const [cmd, ...rest] = helixCommand(generation === 1 ? 'evolve' : 'resume', { config: configPath })
      return await new Promise<number | null>((resolveExit) => {
        const child = spawn(cmd!, rest, { cwd: repo, stdio: 'ignore', signal })
        child.on('error', () => resolveExit(null))
        child.on('exit', (code) => resolveExit(code))
      })
    },
    async onGeneration(report) {
      await ctx.autonomy.audit.record('agent', 'evolution-generation', {
        generation: report.generation,
        exitCode: report.exitCode,
        candidates: report.candidates,
        awaitingApproval: report.eligible.map((r) => ({ branch: r.candidate.branch, score: r.score, protected: r.violations })),
      })
    },
  })
  ctx.provide('evolutionDriver', driver)
  ctx.effect(() => () => { void driver.stop() })

  async function prepare(): Promise<string> {
    await mkdir(join(repo, '.helix'), { recursive: true })
    const evaluator = join(repo, '.helix', 'dsh-evaluate.sh')
    await writeFile(evaluator, script)
    await chmod(evaluator, 0o755)
    const configPath = join(repo, 'helix.toml')
    await writeFile(configPath, `${toToml({ evaluator: { command: 'sh .helix/dsh-evaluate.sh' }, ...config.helix })}\n`)
    return configPath
  }

  void ctx.plugin({
    name: 'evolution-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      const out = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
      const render = (_a: unknown, v: { text: string }) => [{ type: 'text' as const, text: v.text }]
      const audit = (event: string, data: Record<string, unknown>) => ctx.autonomy.audit.record('agent', event, data)

      ctx.tools.register(defineTool({
        name: 'evolution_start',
        description: 'Start a Helix evolution run in the background: coding agents mutate copies of this repository on helix/* branches and the evaluation gates score them. The working branch is never touched.',
        parameters: { resume: { type: 'boolean', description: 'Resume the previous run instead of starting fresh.' } },
        output: { schema: out, render },
        async execute(args) {
          const configPath = await prepare()
          const [cmd, ...rest] = helixCommand(args.resume ? 'resume' : 'evolve', { config: configPath })
          const child = spawn(cmd!, rest, { cwd: repo, detached: true, stdio: 'ignore' })
          child.on('error', () => {})
          child.unref()
          await audit('evolution-start', { resume: !!args.resume, pid: child.pid })
          return { text: `Helix ${args.resume ? 'resumed' : 'started'} (pid ${child.pid ?? '?'}). Check candidates later with evolution_status.` }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'evolution_status',
        description: 'List evolved candidate branches with their size and whether they touch the protected core.',
        parameters: {},
        output: { schema: out, render },
        async execute() {
          const list = await evolution.candidates()
          if (!list.length) return { text: 'No candidates yet.' }
          return {
            text: list.map((c) => {
              const v = evolution.violations(c)
              return `${c.branch}  +${c.insertions}/-${c.deletions} in ${c.files.length} files${v.length ? `  ⚠ protected core: ${v.join(', ')}` : ''}`
            }).join('\n'),
          }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'evolution_review',
        description: 'Re-evaluate a candidate branch in a clean worktree and report whether it is eligible for promotion.',
        parameters: { branch: { type: 'string', required: true } },
        output: { schema: out, render },
        async execute(args) {
          const r = await evolution.review(args.branch)
          return { text: `${args.branch}: ${r.eligible ? 'eligible' : 'not eligible'} — ${r.reason}${r.score !== undefined ? ` (score ${r.score})` : ''}` }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'evolution_promote',
        description: 'Merge an eligible candidate into the working branch. Critical risk: always requires your owner\'s approval. '
          + 'If the candidate modifies the protected safety core, set acknowledgeProtected: true so your owner sees that explicitly when approving.',
        parameters: {
          branch: { type: 'string', required: true },
          acknowledgeProtected: { type: 'boolean', description: 'Required when the candidate modifies the protected core.' },
        },
        output: { schema: out, render },
        async execute(args) {
          const p = await evolution.promote(args.branch, { acknowledgeProtected: args.acknowledgeProtected })
          await audit('evolution-promote', { ...p })
          return { text: `Promoted ${p.branch} (${p.previousHead.slice(0, 8)} → ${p.mergedHead.slice(0, 8)}). Use evolution_rollback to undo.` }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'evolution_autorun',
        description: 'Start or stop continuous evolution. In limitless mode generations run without end and may mutate any file; '
          + 'eligible candidates wait for owner-approved promotion. Stops automatically when the kill switch is engaged.',
        parameters: {
          action: { type: 'string', required: true, enum: ['start', 'stop', 'status'] },
        },
        output: { schema: out, render },
        async execute(args) {
          if (args.action === 'start') {
            if (!driver.running) void driver.start()
            await audit('evolution-autorun', { action: 'start', mode: config.mode })
          } else if (args.action === 'stop') {
            await driver.stop()
            await audit('evolution-autorun', { action: 'stop' })
          }
          const waiting = driver.awaitingApproval.map((r) => `  ${r.candidate.branch}${r.score !== undefined ? ` score ${r.score}` : ''}${r.requiresOwnerAck ? ' [modifies protected core]' : ''}`)
          return {
            text: [
              `${config.mode} evolution ${driver.running ? 'running' : 'stopped'}; generation ${driver.generation}${config.maxGenerations ? ` of ${config.maxGenerations}` : ' (unlimited)'}.`,
              waiting.length ? `Awaiting owner approval:\n${waiting.join('\n')}` : 'No candidates awaiting approval.',
            ].join('\n'),
          }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'evolution_rollback',
        description: 'Revert the most recent promotion.',
        parameters: {},
        output: { schema: out, render },
        async execute() {
          const p = await evolution.rollback()
          await audit('evolution-rollback', { ...p })
          return { text: `Rolled back ${p.branch}.` }
        },
      }))
    },
  })
}
