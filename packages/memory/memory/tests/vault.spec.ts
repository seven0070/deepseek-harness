import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Memory from '../src/index.ts'
import { parseNote, slugify, VaultMemory } from '../src/index.ts'

it('writes Obsidian-style notes and recalls owner-written ones too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-'))
  const vault = new VaultMemory({ dir, now: () => new Date('2026-09-29T10:00:00Z') })
  await vault.retain([{ content: 'The staging database runs on port 5433.', kind: 'fact', context: 'deploy task', tags: ['infra'] }])
  await vault.retain([{ content: 'The staging database runs on port 5433.', kind: 'fact' }])
  const files = await readdir(join(dir, 'fact'))
  expect(files.sort()).toEqual(['2026-09-29-the-staging-database-runs-on-port-5433-2.md', '2026-09-29-the-staging-database-runs-on-port-5433.md'])
  const note = await readFile(join(dir, 'fact', files.sort()[1]!), 'utf8')
  expect(note).toContain('context: "deploy task"')
  expect(parseNote(note)).toMatchObject({ kind: 'fact', body: 'The staging database runs on port 5433.' })

  await mkdir(join(dir, 'Projects'), { recursive: true })
  await writeFile(join(dir, 'Projects', 'release plan.md'), '# Release\nShip the harness on Friday after the benchmark run.')
  await mkdir(join(dir, '.obsidian'), { recursive: true })
  await writeFile(join(dir, '.obsidian', 'workspace.md'), 'benchmark benchmark benchmark')
  const hits = await vault.recall('when do we ship after the benchmark?')
  expect(hits[0]!.source).toBe('vault:Projects/release plan.md')
  expect(hits.some((h) => h.source.includes('.obsidian'))).toBe(false)
  expect((await vault.recall('staging port', { kinds: ['fact'] }))[0]!.content).toContain('5433')
  expect(slugify('Ünïcode & spaces!!')).toBe('unicode-spaces')

  const ctx = new Context()
  await ctx.plugin(Memory, { vault: dir, tools: false })
  const merged = await ctx.memory.recall('release Friday')
  expect(merged.hits.some((h) => h.source.startsWith('vault:'))).toBe(true)
  await ctx.fiber.dispose()
})
