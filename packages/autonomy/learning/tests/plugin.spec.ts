import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Core from '@deepseek-ai/dsh-autonomy-core'
import * as Learning from '../src/index.ts'

const signal = new AbortController().signal
let n = 0

it('runs experiments on the computer and gates capability installs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'learn-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Core, { approval: 'deny', autoApprove: 'medium' })
  let i = 0
  ctx.provide('agentComputer', {
    async exec(command: string) { i++; return { code: 0, stdout: command.includes('fast') ? `metric=${1 + (i % 3) / 100}` : `metric=${5 + (i % 3) / 100}`, stderr: '' } },
    async writeFile() {},
  } as never)
  await ctx.plugin(Learning, { skillsDir: join(dir, 'skills') })
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal, callId: ToolCallId(`l${++n}`), name, arguments: args })
  const exp = JSON.stringify(await call('experiment_run', { hypothesis: 'fast wins', variants: [{ name: 'slow', command: 'run slow' }, { name: 'fast', command: 'run fast' }], higherIsBetter: false, trials: 4 }))
  expect(exp).toContain('fast is better than slow')
  const proposed = JSON.stringify(await call('capability_propose', { kind: 'skill', name: 'bench-first', description: 'd', content: 'Benchmark before optimizing.', rationale: 'r', test: 'test -f capabilities/bench-first/SKILL.md' }))
  const id = /Proposal (\w+)/.exec(proposed)![1]!
  expect(JSON.stringify(await call('capability_test', { id }))).toContain('tested')
  // capability_install is high risk; with approvals disabled it is refused.
  expect(JSON.stringify(await call('capability_install', { id }))).toContain('approvals are disabled')
  expect(ctx.learning.capabilities.get(id)!.status).toBe('tested')
  await ctx.fiber.dispose()
})
