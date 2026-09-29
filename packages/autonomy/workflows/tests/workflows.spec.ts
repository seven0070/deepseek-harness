import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Core from '@deepseek-ai/dsh-autonomy-core'
import * as Workflows from '../src/index.ts'
import { template, validate, WorkflowService } from '../src/index.ts'
import type { WorkflowNode } from '../src/index.ts'

const nodes: WorkflowNode[] = [
  { id: 'test', kind: 'tool', tool: 'echo', args: { text: 'tests {{input.result}}' }, next: 'check' },
  { id: 'check', kind: 'condition', test: { regex: 'fail' }, then: 'ask', else: 'done' },
  { id: 'ask', kind: 'approval', message: 'Tests said: {{test}}. File an issue?', next: 'file' },
  { id: 'file', kind: 'tool', tool: 'echo', args: { text: 'issue filed for {{test}}' } },
  { id: 'done', kind: 'delay', ms: 1000 },
]

function fakeTools(calls: string[]) {
  return () => ({
    async execute(input: { name: string, arguments: unknown }) {
      const text = String((input.arguments as { text: string }).text)
      calls.push(text)
      return { isError: input.name !== 'echo', content: [{ type: 'text', text }] }
    },
  })
}

describe('engine', () => {
  it('validates graphs and templates values', () => {
    expect(validate({ start: 'test', nodes })).toEqual([])
    expect(validate({ start: 'x', nodes: [{ id: 'a', kind: 'delay', ms: 1, next: 'b' }, { id: 'a', kind: 'condition', test: {}, then: 'a' }] }))
      .toEqual(['duplicate node id a', 'start node x does not exist', 'a points to missing node b', 'a has an empty test'])
    expect(template({ a: ['{{n}} {{input.k}} {{missing}}'] }, { outputs: { n: 'N' }, input: { k: 1 } })).toEqual({ a: ['N 1 {{missing}}'] })
  })

  it('runs, pauses for approval, survives a restart, and resumes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-'))
    const calls: string[] = []
    const a = new WorkflowService({ dir, tools: fakeTools(calls) })
    const wf = await a.propose({ name: 'ci-check', description: 'd', start: 'test', nodes })
    await expect(a.start(wf.id)).rejects.toThrow(/activated by the owner/)
    await a.setStatus(wf.id, 'active')
    const run = await a.start('ci-check', { result: 'failed' })
    expect(run.status).toBe('waiting-approval')
    expect(run.log.at(-1)!.note).toContain('Tests said: tests failed')

    const b = new WorkflowService({ dir, tools: fakeTools(calls) }) // "restart"
    await b.load()
    const resumed = await b.approve(run.id, true)
    expect(resumed.status).toBe('succeeded')
    expect(calls.at(-1)).toBe('issue filed for tests failed')

    let clock = new Date('2026-01-01T00:00:00Z')
    const c = new WorkflowService({ tools: fakeTools(calls), now: () => clock })
    const w2 = await c.propose({ name: 'ok', description: 'd', start: 'test', nodes })
    await c.setStatus(w2.id, 'active')
    const r2 = await c.start(w2.id, { result: 'passed' })
    expect(r2.status).toBe('waiting-delay')
    await c.tick()
    expect(r2.status).toBe('waiting-delay')
    clock = new Date(clock.getTime() + 1500)
    await c.tick()
    expect(r2.status).toBe('succeeded')

    const refused = await c.start(w2.id, { result: 'fail' })
    expect((await c.approve(refused.id, false)).status).toBe('cancelled')
  })

  it('fails cleanly on tool errors and runs schedules', async () => {
    let clock = new Date('2026-01-01T00:00:00Z')
    const calls: string[] = []
    const s = new WorkflowService({ tools: fakeTools(calls), now: () => clock })
    const bad = await s.propose({ name: 'bad', description: 'd', start: 'x', nodes: [{ id: 'x', kind: 'tool', tool: 'nope', args: { text: 'boom' } }] })
    await s.setStatus(bad.id, 'active')
    expect((await s.start(bad.id)).error).toMatch(/nope failed/)
    const sched = await s.propose({ name: 'tick', description: 'd', start: 'x', nodes: [{ id: 'x', kind: 'tool', tool: 'echo', args: { text: 'ping' } }], trigger: { kind: 'schedule', everyMs: 60_000 } })
    await s.tick()
    expect(calls).not.toContain('ping') // drafts never run
    await s.setStatus(sched.id, 'active')
    await s.tick()
    await s.tick()
    expect(calls.filter((c) => c === 'ping')).toHaveLength(1)
    clock = new Date(clock.getTime() + 61_000)
    await s.tick()
    expect(calls.filter((c) => c === 'ping')).toHaveLength(2)
  })
})

it('plugin: agent drafts, activation needs owner approval, workflow tools go through the gate', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Core, { approval: 'deny', extraRules: [{ action: 'echo', risk: 'low' }] })
  await ctx.plugin(Workflows, { tickMs: 60_000 })
  const out = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
  ctx.tools.register(defineTool({ name: 'echo', description: 'Echo text.', parameters: { text: { type: 'string', required: true } }, output: { schema: out, render: (_a, v) => [{ type: 'text', text: v.text }] }, async execute(args) { return { text: args.text } } }))
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`w${Math.random()}`), name, arguments: args })
  const drafted = JSON.stringify(await call('workflow_propose', { name: 'hello', description: 'd', start: 'a', nodes: [{ id: 'a', kind: 'tool', tool: 'echo', args: { text: 'hi {{input.who}}' } }] }))
  const id = /Drafted workflow (\w+)/.exec(drafted)![1]!
  expect(JSON.stringify(await call('workflow_activate', { id }))).toContain('approvals are disabled')
  expect(ctx.workflows.must(id).status).toBe('draft')
  await ctx.workflows.setStatus(id, 'active') // what an owner approval does
  // workflow_run is medium risk: also needs approval under approval: deny, so start directly.
  const run = await ctx.workflows.start(id, { who: 'owner' })
  // (tools inside the workflow still pass the gate: an unclassified tool would be refused here)
  expect(run.status).toBe('succeeded')
  expect(run.outputs.a).toBe('hi owner')
  expect(JSON.stringify(await call('workflow_status', {}))).toContain('hello [active]')
  await ctx.fiber.dispose()
})
