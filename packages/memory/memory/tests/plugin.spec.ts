import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Memory from '../src/index.ts'

const signal = new AbortController().signal
let n = 0

it('provides ctx.memory and working memory tools', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Memory, {})
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal, callId: ToolCallId(`m${++n}`), name, arguments: args })
  expect(ctx.memory.list()).toEqual(['local'])
  expect(JSON.stringify(await call('memory_retain', { content: 'The deploy key lives in vault path ops/deploy', kind: 'fact' }))).toContain('Saved')
  expect(JSON.stringify(await call('memory_recall', { query: 'where is the deploy key' }))).toContain('ops/deploy')
  expect(JSON.stringify(await call('memory_reflect', { query: 'deploy key' }))).toContain('ops/deploy')
  await ctx.fiber.dispose()
})
