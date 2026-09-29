import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Efficiency from '../src/index.ts'
import { compress, costOf, decide, Journal, priceFor, ToolIndex } from '../src/index.ts'

const tools = [
  { name: 'bash', description: 'Run a shell command and return its output.' },
  { name: 'read_file', description: 'Read a text file from the workspace.' },
  { name: 'web_search', description: 'Search the web for current information.' },
  { name: 'memory_recall', description: 'Recall memories relevant to a query.' },
  { name: 'computer_snapshot', description: 'Snapshot the agent computer disk so it can be restored.' },
]

describe('tool ranking', () => {
  it('retrieves, decides with probabilities, and abstains when nothing fits', async () => {
    const index = new ToolIndex(tools)
    expect(index.search('search the web for news')[0]!.name).toBe('web_search')
    const d = await decide(index, 'read the file config.yaml')
    expect(d.choice).toBe('read_file')
    expect(Object.values(d.probabilities).reduce((s, p) => s + p, 0)).toBeCloseTo(1)
    const none = await decide(index, 'what is two plus two')
    expect(none.abstained).toBe(true)
    // A plugged-in chooser overrides retrieval scores; unknown names are ignored.
    const custom = await decide(index, 'run command in shell', { chooser: async () => ({ bash: 1, made_up: 50, none: 0 }) })
    expect(custom.choice).toBe('bash')
    expect(custom.probabilities.made_up).toBeUndefined()
    // A failing chooser falls back to BM25.
    expect((await decide(index, 'snapshot disk', { chooser: async () => { throw new Error('x') } })).choice).toBe('computer_snapshot')
  })
})

describe('compression', () => {
  it('folds repeats, strips escapes, keeps important lines from long output', () => {
    const small = compress('hello')
    expect(small.changed).toBe(false)
    const progress = Array.from({ length: 300 }, (_, i) => `\u001b[32mdownloading ${i}/300\u001b[0m`).join('\n')
    const c = compress(`start\n${progress}\ndone`)
    expect(c.text).toContain('similar lines omitted')
    expect(c.text).not.toContain('\u001b[')
    expect(c.after).toBeLessThan(c.before / 10)
    const log = Array.from({ length: 2000 }, (_, i) => (i === 1000 ? 'Error: connection refused at db.ts:42' : `step ${String.fromCharCode(97 + (i % 26))}${'x'.repeat(i % 7)} ok`)).join('\n')
    const l = compress(log, { maxChars: 3000 })
    expect(l.text).toContain('Error: connection refused')
    expect(l.text).toMatch(/lines omitted/)
  })
})

describe('journal', () => {
  it('prices calls by model glob and summarises runs', async () => {
    const prices = { 'deepseek-*': { input: 0.28, output: 0.42, cacheRead: 0.028 }, 'deepseek-reasoner': { input: 0.55, output: 2.19 } }
    expect(priceFor('deepseek-reasoner', prices)!.input).toBe(0.55)
    expect(priceFor('DeepSeek-Chat', prices)!.input).toBe(0.28)
    expect(priceFor('gpt-x', prices)).toBeUndefined()
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 500_000 }, prices['deepseek-*'])).toBeCloseTo(0.14 + 0.014 + 0.42)
    const j = new Journal()
    await j.record({ kind: 'llm', run: 'r', at: new Date().toISOString(), model: 'deepseek-chat', durationMs: 10, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, costUsd: 0.001 })
    await j.record({ kind: 'llm', run: 'r', at: new Date().toISOString(), model: 'local', durationMs: 10, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 })
    await j.record({ kind: 'tool', run: 'r', at: new Date().toISOString(), tool: 'bash', callId: '1', isError: true, args: {}, outputChars: 100, compressedFrom: 900 })
    const s = j.summary('r')
    expect(s).toMatchObject({ llmCalls: 2, toolCalls: 1, toolErrors: 1, unpricedCalls: 1, savedChars: 800 })
    expect(s.costUsd).toBeCloseTo(0.001)
    expect(j.format('r')).toContain('tool bash ERROR')
  })
})

it('plugin: compresses noisy tool output, journals calls, and serves tool_search', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Efficiency)
  const out = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Run a shell command.',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: out, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute() { return { text: Array.from({ length: 500 }, (_, i) => `compiling module ${i}`).join('\n') } },
  }))
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`c${Math.random()}`), name, arguments: args })
  const r = await call('bash', { command: 'make' })
  const text = JSON.stringify(r.content)
  expect(text).toContain('similar lines omitted')
  expect(text.length).toBeLessThan(1000)
  expect(JSON.stringify((await call('tool_search', { need: 'run a shell command' })).content)).toContain('Use bash')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const summary = ctx.efficiency.journal.summary(ctx.efficiency.run)
  expect(summary.toolCalls).toBe(2)
  expect(summary.savedChars).toBeGreaterThan(5000)
  expect(JSON.stringify((await call('run_journal', {})).content)).toContain('Compression saved')
  await ctx.fiber.dispose()
})
