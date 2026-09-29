import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEdits, CapabilityRegistry, optimizeSkill, parseMetric, renderSkill, runExperiment, skillOptCommand, stats, welchP } from '../src/index.ts'
import type { SkillEdit } from '../src/index.ts'

describe('optimizeSkill', () => {
  // Toy world: a task passes iff the skill mentions its keyword.
  const tasks = ['tests', 'types', 'docs', 'lint']
  const rollout = async (skill: string, task: string) => ({ score: skill.includes(task) ? 1 : 0, trace: `missing ${task}` })

  it('accepts only validation-improving, bounded edits and remembers rejects', async () => {
    const proposals: SkillEdit[][] = []
    const result = await optimizeSkill({
      skill: '# Coding skill\nBe careful.\n',
      train: tasks,
      validation: tasks,
      rollout,
      batchSize: 1,
      epochs: 1,
      maxCharsPerStep: 60,
      async propose(_skill, failures, rejected) {
        const task = failures[0]!.task
        const edits: SkillEdit[] = task === 'docs'
          ? [{ op: 'add', text: 'x'.repeat(100) }] // too large
          : task === 'lint'
            ? [{ op: 'add', text: 'Irrelevant advice.' }] // does not help
            : [{ op: 'add', text: `Always check ${task}.` }]
        proposals.push(edits)
        return edits.filter((e) => !rejected.some((r) => r.text === e.text))
      },
    })
    expect(result.baselineValScore).toBe(0)
    expect(result.bestValScore).toBe(0.5)
    expect(result.improved).toBe(true)
    expect(result.bestSkill).toContain('Always check tests.')
    expect(result.bestSkill).not.toContain('Irrelevant')
    expect(result.history.map((h) => h.reason)).toEqual(['validation improved', 'validation improved', expect.stringContaining('too large'), 'validation did not improve'])
  })

  it('applies add / replace / delete and skips missing targets', () => {
    const r = applyEdits('a\nb\nc', [{ op: 'replace', target: 'b', text: 'B' }, { op: 'delete', target: 'c' }, { op: 'delete', target: 'zz' }, { op: 'add', text: 'd' }])
    expect(r.skill).toBe('a\nB\nd\n')
    expect(r.applied).toHaveLength(3)
    expect(skillOptCommand({ config: 'c.yaml', outputDir: 'out', backend: 'openai_chat' })).toContain('--backend')
  })
})

describe('experiments', () => {
  it('finds a significant winner and reports inconclusive results honestly', async () => {
    const noisy = (base: number) => (i: number) => base + ((i * 7919) % 10) / 100
    const clear = await runExperiment({
      hypothesis: 'b is faster', variants: ['a', 'b'], trials: 8, higherIsBetter: false,
      trial: async (v, i) => (v === 'a' ? noisy(2) : noisy(1))(i),
    })
    expect(clear.winner).toBe('b')
    const tie = await runExperiment({ hypothesis: 'same', variants: ['a', 'b'], trials: 6, trial: async (_v, i) => noisy(1)(i) })
    expect(tie.winner).toBeUndefined()
    expect(tie.conclusion).toMatch(/No significant difference/)
    const flaky = await runExperiment({ hypothesis: 'x', variants: ['a', 'b'], trials: 3, trial: async (v) => { if (v === 'a') throw new Error('boom'); return 1 } })
    expect(flaky.variants.find((v) => v.name === 'a')!.failures).toBe(3)
    expect(welchP(stats('a', [1, 1]), stats('b', [1, 1]))).toBe(1)
    expect(parseMetric('warmup 3\nmetric=0.25\nmetric: 0.5 done')).toBe(0.5)
    expect(parseMetric('took 12.5s')).toBe(12.5)
  })
})

describe('CapabilityRegistry', () => {
  it('requires passing tests before install and writes a discoverable skill', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cap-'))
    const reg = new CapabilityRegistry({
      skillsDir: join(dir, 'skills'),
      scriptsDir: join(dir, 'bin'),
      runTest: async (command, files) => ({ ok: command === 'true' && Object.keys(files)[0]!.endsWith('SKILL.md'), output: 'ran' }),
    })
    expect(() => reg.propose({ kind: 'skill', name: 'Bad Name', description: 'd', content: 'c', rationale: 'r' })).toThrow(/kebab/)
    const bad = reg.propose({ kind: 'skill', name: 'deploy-check', description: 'd', content: 'steps', rationale: 'r', test: 'false' })
    await reg.test(bad.id)
    expect(bad.status).toBe('failed-tests')
    await expect(reg.install(bad.id)).rejects.toThrow(/test it first/)
    const good = reg.propose({ kind: 'skill', name: 'release-notes', description: 'Write "release" notes', content: '1. Read the log', rationale: 'r', test: 'true' })
    await reg.test(good.id)
    const { path } = await reg.install(good.id)
    expect(await readFile(path, 'utf8')).toBe(renderSkill(good))
    expect(await readFile(path, 'utf8')).toContain('name: release-notes')
    const script = reg.propose({ kind: 'script', name: 'hello', description: 'd', content: '#!/bin/sh\necho hi', rationale: 'r' })
    await reg.test(script.id)
    const installed = await reg.install(script.id)
    expect((await stat(installed.path)).mode & 0o111).toBeTruthy()
  })
})
