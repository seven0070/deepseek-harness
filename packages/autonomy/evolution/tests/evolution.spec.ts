import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Core from '@deepseek-ai/dsh-autonomy-core'
import * as Evo from '../src/index.ts'
import { evaluatorScript, Evolution, helixCommand, parseHelixResult, toToml } from '../src/index.ts'

const run = promisify(execFile)

async function repo(): Promise<{ dir: string, git: (args: readonly string[]) => Promise<string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'evo-'))
  const git = async (args: readonly string[]) => (await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir })).stdout
  await git(['init', '-q', '-b', 'main'])
  await writeFile(join(dir, 'app.txt'), 'v1\n')
  await git(['add', '.'])
  await git(['commit', '-qm', 'init'])
  const branch = async (name: string, file: string, content: string) => {
    await git(['checkout', '-qb', name])
    await mkdir(join(dir, file, '..'), { recursive: true })
    await writeFile(join(dir, file), content)
    await git(['add', '.'])
    await git(['commit', '-qm', name])
    await git(['checkout', '-q', 'main'])
  }
  await branch('helix/good', 'app.txt', 'v2\n')
  await branch('helix/sneaky', 'packages/autonomy/autonomy-core/src/index.ts', 'export {}\n')
  return { dir, git }
}

describe('helix bridge', () => {
  it('renders toml, commands, and parses the evaluator contract', async () => {
    expect(toToml({ seed: 1, name: 'x', tags: ['a', 'b'], agent: { cli: 'claude', 'max-turns': 3 } }))
      .toBe('seed = 1\nname = "x"\ntags = ["a", "b"]\n\n[agent]\ncli = "claude"\nmax-turns = 3')
    expect(helixCommand('evolve', { config: 'helix.toml' })).toEqual(['helix', 'evolve', '--config', 'helix.toml'])
    expect(parseHelixResult('noise\nHELIX_RESULT {"score": 0.5, "latency": 3}')).toEqual({ score: 0.5, metrics: { latency: 3 }, raw: { score: 0.5, latency: 3 } })
    expect(parseHelixResult('HELIX_RESULT: 0.9')!.score).toBe(0.9)
    expect(parseHelixResult('nothing')).toBeUndefined()
    const dir = await mkdtemp(join(tmpdir(), 'gate-'))
    const script = join(dir, 'eval.sh')
    await writeFile(script, evaluatorScript([{ name: 'ok', command: 'true' }, { name: 'soft', command: 'false', required: false }]))
    expect(parseHelixResult((await run('sh', [script])).stdout)).toMatchObject({ score: 0.5, metrics: { ok: 1, soft: 0 } })
    await writeFile(script, evaluatorScript([{ name: 'ok', command: 'echo \'quoted\'' }, { name: 'hard', command: 'exit 1' }]))
    expect(parseHelixResult((await run('sh', [script])).stdout)!.score).toBe(0)
  })
})

describe('Evolution', () => {
  it('refuses protected-core changes and failing scores, promotes and rolls back', async () => {
    const { dir, git } = await repo()
    const scores: Record<string, number> = { 'helix/good': 0.8 }
    const evo = new Evolution({ git, protectedPatterns: Core.DEFAULT_PROTECTED, evaluate: async (b) => scores[b], minScore: 0.5 })
    const list = await evo.candidates()
    expect(list.map((c) => c.branch).sort()).toEqual(['helix/good', 'helix/sneaky'])
    expect((await evo.review('helix/sneaky')).reason).toMatch(/protected core/)
    await expect(evo.promote('helix/sneaky')).rejects.toThrow(/not eligible/)
    const p = await evo.promote('helix/good')
    expect(await readFile(join(dir, 'app.txt'), 'utf8')).toBe('v2\n')
    expect(p.score).toBe(0.8)
    await evo.rollback()
    expect(await readFile(join(dir, 'app.txt'), 'utf8')).toBe('v1\n')
    scores['helix/good'] = 0.2
    expect((await evo.review('helix/good')).eligible).toBe(false)
  })
})

it('plugin: promotion is critical and needs approval; status is readable', async () => {
  const { dir, git } = await repo()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Core, { approval: 'deny' })
  await ctx.plugin({ name: 'evo', inject: ['autonomy'], apply: (c: Context) => Evo.apply(c, Evo.Config({ repoDir: dir } as Evo.Config), { git }) })
  const signal = new AbortController().signal
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal, callId: ToolCallId(`e${name}`), name, arguments: args })
  const status = JSON.stringify(await call('evolution_status', {}))
  expect(status).toContain('helix/good')
  expect(status).toContain('protected')
  expect(JSON.stringify(await call('evolution_promote', { branch: 'helix/good' }))).toContain('approvals are disabled')
  expect(await readFile(join(dir, 'app.txt'), 'utf8')).toBe('v1\n')
  await ctx.fiber.dispose()
})

describe('limitless evolution', () => {
  it('lets protected-core mutations through only with explicit acknowledgement, and persists promotions', async () => {
    const { dir, git } = await repo()
    const stateFile = join(dir, '.helix', 'promotions.json')
    const evo = new Evolution({ git, protectedPatterns: Core.DEFAULT_PROTECTED, protectedCore: 'owner-approval', stateFile })
    const review = await evo.review('helix/sneaky')
    expect(review).toMatchObject({ eligible: true, requiresOwnerAck: true })
    expect(review.reason).toMatch(/PROTECTED CORE/)
    await expect(evo.promote('helix/sneaky')).rejects.toThrow(/acknowledgeProtected/)
    const p = await evo.promote('helix/sneaky', { acknowledgeProtected: true })
    expect(p.protectedFiles).toEqual(['packages/autonomy/autonomy-core/src/index.ts'])
    const reloaded = new Evolution({ git, protectedPatterns: Core.DEFAULT_PROTECTED, stateFile })
    await reloaded.load()
    expect(reloaded.promotions.map((x) => x.branch)).toEqual(['helix/sneaky'])
    await reloaded.rollback()
    expect((await git(['ls-files'])).includes('autonomy-core')).toBe(false)
  })

  it('runs unlimited generations until stopped or killed', async () => {
    const { git } = await repo()
    const evo = new Evolution({ git, protectedPatterns: Core.DEFAULT_PROTECTED, protectedCore: 'owner-approval' })
    const kill = new AbortController()
    let runs = 0
    const driver = new Evo.LimitlessDriver({
      evolution: evo,
      killSignal: kill.signal,
      async runGeneration() { runs++; if (runs === 3) kill.abort(); return 0 },
    })
    await driver.start()
    expect(runs).toBe(3)
    expect(driver.reports).toHaveLength(2) // the killed generation is not reviewed
    expect(driver.awaitingApproval.map((r) => r.candidate.branch).sort()).toEqual(['helix/good', 'helix/sneaky'])
    expect(driver.running).toBe(false)

    const capped = new Evo.LimitlessDriver({ evolution: evo, maxGenerations: 2, runGeneration: async () => 0 })
    await capped.start()
    expect(capped.generation).toBe(2)
  })
})
