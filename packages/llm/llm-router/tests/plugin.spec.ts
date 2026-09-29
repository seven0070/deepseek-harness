/** The plugin mounts pi-ai routes for every detected key without naming a provider. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import * as Router from '../src/index.ts'

afterEach(() => vi.unstubAllEnvs())

it('detects keys from the environment and registers their providers', async () => {
  vi.stubEnv('SOME_VENDOR_API_KEY', `gsk_${'x'.repeat(40)}`)
  vi.stubEnv('ANTHROPIC_API_KEY', `sk-ant-api03-${'y'.repeat(40)}`)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Router, { probe: false })
    const groq = await ctx.llm.listModels('groq')
    expect(groq.length).toBeGreaterThan(0)
    const anthropic = await ctx.llm.listModels('anthropic')
    expect(anthropic.length).toBeGreaterThan(0)
  } finally {
    await ctx.fiber.dispose()
  }
})
