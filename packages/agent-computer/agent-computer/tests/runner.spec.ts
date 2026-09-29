import { expect, it } from 'vitest'
import { spawnRunner } from '../src/runner.ts'

it('spawns without a shell, feeds stdin, and reports exit codes', async () => {
  expect(await spawnRunner(['node', '-e', 'process.stdin.pipe(process.stdout)'], { input: 'hi $(x)' }))
    .toMatchObject({ code: 0, stdout: 'hi $(x)' })
  expect((await spawnRunner(['node', '-e', 'process.exit(3)'])).code).toBe(3)
  expect((await spawnRunner(['definitely-not-a-binary-xyz'])).code).toBe(127)
})

it('kills commands that exceed their timeout', async () => {
  const result = await spawnRunner(['node', '-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 })
  expect(result.timedOut).toBe(true)
})
