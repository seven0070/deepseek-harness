import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Core from '@deepseek-ai/dsh-autonomy-core'
import * as Executive from '../src/index.ts'

const signal = new AbortController().signal
let n = 0

it('drives real tools through the gate from goals and plans set by tools', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Core, { approval: 'host' })
  await ctx.plugin(Executive, {})
  const ran: unknown[] = []
  ctx.tools.register(defineTool({
    name: 'computer_exec', description: 'x', parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'integer', required: true } } }, render: () => [{ type: 'text', text: 'done' }] },
    async execute(args) { ran.push(args.command); return { exitCode: args.command === 'bad' ? 1 : 0 } },
  }))
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal, callId: ToolCallId(`e${++n}`), name, arguments: args })
  const added = JSON.stringify(await call('goal_add', { title: 'build it' }))
  expect(added).toContain('proposed')
  const id = /Goal (\w+)/.exec(added)![1]!
  ctx.executive.goals.update('owner', id, { status: 'active' })
  await call('plan_set', { goalId: id, steps: [{ id: 's1', description: 'compile', tool: 'computer_exec', args: { command: 'make' } }, { id: 's2', description: 'fail', dependsOn: ['s1'], tool: 'computer_exec', args: { command: 'bad' } }] })
  expect(await ctx.executive.tick()).toMatchObject({ kind: 'worked', ok: true })
  expect(await ctx.executive.tick()).toMatchObject({ kind: 'worked', ok: false })
  expect(ran).toEqual(['make', 'bad'])
  expect(JSON.stringify(await call('plan_status', { goalId: id }))).toContain('[failed] s2')
  expect(JSON.stringify(await call('belief_observe', { statement: 'make works', supports: true, source: 'run', reliability: 0.9 }))).toContain('90%')
  expect(JSON.stringify(await call('belief_query', { query: 'make' }))).toContain('make works')
  await ctx.fiber.dispose()
})
