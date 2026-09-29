/**
 * End-to-end: a scripted model drives the whole autonomy stack through the
 * real LLM runtime — goal → plan → delegated tool use through the
 * authorization gate → verification → memory → journal and cost.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Autonomy from '../src/index.ts'
import { extractJson } from '../src/index.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly prompts: string[] = []
  constructor(private readonly reply: (options: GenerateOptions, prompt: string) => string) { super() }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model } as LlmResolvedModelInfo
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const msg = options.messages.at(-1) as { content: { type: string, text?: string }[] }
    const prompt = msg.content.map((c) => c.text ?? '').join('')
    this.prompts.push(prompt)
    const text = this.reply(options, prompt)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } }
    yield { type: 'finish', reason: 'stop' }
  }
}

const out = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
const render = (_a: unknown, v: { text: string }) => [{ type: 'text' as const, text: v.text }]

it('extracts JSON from chatty model output', () => {
  expect(extractJson('Sure!\n```json\n{"a": {"b": "}"}}\n```')).toEqual({ a: { b: '}' } })
  expect(extractJson('no json')).toBeUndefined()
})

it('runs a goal end to end through the real LLM runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-e2e-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)

  const notes: string[] = []
  ctx.tools.register(defineTool({
    name: 'note_write', description: 'Write a release note.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: out, render },
    async execute(args) { notes.push(args.text); return { text: `saved note ${notes.length}` } },
  }))
  ctx.tools.register(defineTool({
    name: 'run_tests', description: 'Run the test suite.', parameters: {},
    output: { schema: out, render },
    async execute() { return { text: notes.length ? '12 passed' : 'no notes yet' } },
  }))
  ctx.tools.register(defineTool({
    name: 'deploy', description: 'Deploy to production.', parameters: {},
    output: { schema: out, render },
    async execute() { throw new Error('should never run without approval') },
  }))

  const adapter = new ScriptedAdapter((options, prompt) => {
    if (options.system?.includes('planning module')) {
      expect(prompt).toContain('note_write')
      return 'Here is the plan:\n```json\n' + JSON.stringify({ steps: [
        { id: 'write', description: 'Write the release note for v1' },
        { id: 'test', description: 'Run the tests', tool: 'run_tests', args: {}, dependsOn: ['write'] },
        { id: 'ship', description: 'Deploy', tool: 'deploy', args: {}, dependsOn: ['test'] },
      ] }) + '\n```'
    }
    // Delegate: first call a tool, then finish.
    if (!prompt.includes('So far')) return JSON.stringify({ tool: 'note_write', args: { text: 'v1: faster startup' } })
    return JSON.stringify({ done: true, ok: true, result: 'note written' })
  })
  ctx.llm.registerAdapter(['fake'], adapter)

  await ctx.plugin(Autonomy, {
    stateDir: dir,
    model: { provider: 'fake', model: 'fake-1' },
    plannerTools: 40,
    core: { name: 'Ada', approval: 'deny', extraRules: [{ action: 'note_write', risk: 'low' }, { action: 'run_tests', risk: 'read' }] },
    efficiency: { enabled: true, journal: { path: join(dir, 'journal.jsonl'), prices: { 'fake-*': { input: 1, output: 2 } } } },
    learning: { enabled: false },
    subjectivity: { enabled: true },
  })
  await new Promise((r) => setTimeout(r, 20))
  expect(ctx.executive.hasPlanner).toBe(true)

  const goal = ctx.executive.goals.add('owner', { title: 'Ship release notes', successCriteria: ['tests pass'] })
  const reports = []
  for (let i = 0; i < 8; i++) {
    const r = await ctx.executive.tick()
    reports.push(r)
    if (r.kind === 'idle') break
  }
  const plan = ctx.executive.plans.get(goal.id)!
  expect(plan.steps.map((s) => [s.id, s.status])).toEqual([['write', 'done'], ['test', 'done'], ['ship', 'failed']])
  expect(notes).toEqual(['v1: faster startup'])
  // Deploy is unclassified → needs approval → refused non-interactively; nothing ran.
  expect(JSON.stringify(reports)).toContain('Requires approval')
  expect(ctx.executive.goals.get(goal.id)!.status).toBe('blocked') // waits for a human

  // Memory, journal & cost, research feed, prompt, audit.
  const mem = await ctx.memory.recall('release note')
  expect(mem.hits.some((h) => h.content.includes('Write the release note'))).toBe(true)
  const s = ctx.efficiency.journal.summary(ctx.efficiency.run)
  expect(s.llmCalls).toBe(3)
  expect(s.costUsd).toBeCloseTo(3 * (1000 * 1 + 200 * 2) / 1e6)
  expect(await readFile(join(dir, 'journal.jsonl'), 'utf8')).toContain('"model":"fake-1"')
  expect(ctx.subjectivity.report().indicators.find((i) => i.id === 'agency')!.samples).toBeGreaterThan(0)
  const prompt = renderPrompt(await ctx.systemPrompt.assemble())
  expect(prompt).toContain('You are Ada')
  expect((await ctx.autonomy.audit.verify()).ok).toBe(true)
  await ctx.fiber.dispose()
})
