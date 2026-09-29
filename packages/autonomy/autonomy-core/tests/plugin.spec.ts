import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Core from '../src/index.ts'

const signal = new AbortController().signal
let n = 0

it('gates real tool calls and exposes self tools', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Core, { approval: 'deny', name: 'nova' })
  const ran: string[] = []
  for (const name of ['read', 'bash']) {
    ctx.tools.register(defineTool({
      name, description: name, parameters: { command: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
      async execute() { ran.push(name); return {} },
    }))
  }
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal, callId: ToolCallId(`a${++n}`), name, arguments: args })
  await call('read', {})
  const denied = await call('bash', { command: 'make' })
  expect(ran).toEqual(['read'])
  expect(JSON.stringify(denied)).toContain('approvals are disabled')
  expect(JSON.stringify(await call('self_describe', {}))).toContain('You are nova')
  expect(JSON.stringify(await call('self_record_outcome', { capability: 'testing', success: true }))).toContain('67%')
  ctx.autonomy.killSwitch.engage('owner')
  expect(JSON.stringify(await call('read', {}))).toContain('Stopped')
  await ctx.fiber.dispose()
})
