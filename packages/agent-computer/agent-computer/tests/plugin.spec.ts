import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Computer from '../src/index.ts'
import { fakeDocker } from './fake-docker.ts'

const signal = new AbortController().signal
let n = 0

async function setup(extra: Partial<Computer.Config> = {}) {
  const docker = fakeDocker()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Computer, { runner: docker.runner, ...extra })
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal, callId: ToolCallId(`c${++n}`), name, arguments: args })
  return { ctx, docker, call }
}

it('registers the computer tools and service', async () => {
  const { ctx, call } = await setup()
  expect(ctx.agentComputer).toBeInstanceOf(Computer.AgentComputer)
  const exec = await call('computer_exec', { command: 'uname -a' })
  expect(JSON.stringify(exec)).toContain('ran: uname -a')
  const status = await call('computer_status', {})
  expect(JSON.stringify(status)).toContain('running')
  const snap = await call('computer_snapshot', { tag: 'v1' })
  expect(JSON.stringify(snap)).toContain('dsh-computer/primary:v1')
  const restore = await call('computer_restore', { tag: 'v1' })
  expect(JSON.stringify(restore)).toMatch(/not|unknown|error/i)
  await ctx.fiber.dispose()
})

it('exposes restore only when allowed', async () => {
  const { ctx, call } = await setup({ modelRestore: true })
  await call('computer_exec', { command: 'true' })
  await call('computer_snapshot', { tag: 'v1' })
  const restore = await call('computer_restore', { tag: 'v1' })
  expect(JSON.stringify(restore)).toContain('running')
  await ctx.fiber.dispose()
})
