import { describe, expect, it } from 'vitest'
import { detectKey, maskKey, normalizeKey, planRoutes, probeKey, resolveKey, route, scanEnv } from '../src/index.ts'
import type { FetchLike, ModelFacts } from '../src/index.ts'

const r = (n: number, chars = 'aB3dE5gH7j') => Array.from({ length: n }, (_, i) => chars[i % chars.length]).join('')

describe('detectKey', () => {
  it.each([
    [`sk-ant-api03-${r(40)}`, 'anthropic'],
    [`sk-or-v1-${r(40)}`, 'openrouter'],
    [`sk-proj-${r(40)}`, 'openai'],
    [`AIza${r(35)}`, 'google'],
    [`gsk_${r(40)}`, 'groq'],
    [`xai-${r(40)}`, 'xai'],
    [`hf_${r(30)}`, 'huggingface'],
    [`nvapi-${r(40)}`, 'nvidia'],
    [`csk-${r(40)}`, 'cerebras'],
    [`fw_${r(30)}`, 'fireworks'],
    ['AKIAABCDEFGHIJKLMNOP', 'amazon-bedrock'],
  ])('recognizes %s as %s unambiguously', (key, provider) => {
    const d = detectKey(key)
    expect(d.provider).toBe(provider)
    expect(d.ambiguous).toBe(false)
  })

  it('flags a bare sk- hex key as ambiguous with deepseek first', () => {
    const d = detectKey(`sk-${'0123456789abcdef'.repeat(2)}`)
    expect(d.provider).toBe('deepseek')
    expect(d.ambiguous).toBe(true)
    expect(d.candidates.map((c) => c.provider)).toEqual(expect.arrayContaining(['deepseek', 'openai', 'moonshotai']))
  })

  it('lets a conventional env name settle an ambiguous shape', () => {
    const d = detectKey(`sk-${'0123456789abcdef'.repeat(2)}`, 'MOONSHOT_API_KEY')
    expect(d.provider).toBe('moonshotai')
    expect(d.ambiguous).toBe(false)
  })

  it('returns nothing for garbage', () => {
    expect(detectKey('hello').provider).toBeUndefined()
    expect(detectKey('').candidates).toEqual([])
  })

  it('normalizes quotes, whitespace and Bearer prefixes', () => {
    expect(normalizeKey('  "Bearer gsk_abc"  ')).toBe('gsk_abc')
    expect(detectKey(` 'gsk_${r(30)}' \n`).provider).toBe('groq')
  })

  it('masks keys', () => {
    expect(maskKey('gsk_1234567890abcdef')).toBe('gsk_12…cdef')
    expect(maskKey('short')).toBe('***')
  })
})

describe('probing', () => {
  const fakeFetch = (accepts: string): FetchLike => async (url, init) => {
    const ok = url.includes(accepts)
    expect(init.headers.authorization ?? init.headers['x-api-key'] ?? url).toBeTruthy()
    return { status: ok ? 200 : 401 }
  }

  it('reports accept / reject / inconclusive', async () => {
    expect(await probeKey('openai', 'k', { fetch: fakeFetch('openai.com') })).toBe(true)
    expect(await probeKey('openai', 'k', { fetch: fakeFetch('nowhere') })).toBe(false)
    expect(await probeKey('openai', 'k', { fetch: async () => ({ status: 500 }) })).toBeUndefined()
    expect(await probeKey('openai', 'k', { fetch: async () => { throw new Error('offline') } })).toBeUndefined()
    expect(await probeKey('no-such', 'k', { fetch: fakeFetch('x') })).toBeUndefined()
  })

  it('uses x-api-key for anthropic and ?key= for google', async () => {
    const seen: { url: string, headers: Record<string, string> }[] = []
    const spy: FetchLike = async (url, init) => { seen.push({ url, headers: init.headers }); return { status: 200 } }
    await probeKey('anthropic', 'A', { fetch: spy })
    await probeKey('google', 'G', { fetch: spy })
    expect(seen[0].headers['x-api-key']).toBe('A')
    expect(seen[0].headers['anthropic-version']).toBeDefined()
    expect(seen[1].url).toContain('key=G')
  })

  it('resolves an ambiguous key to the provider that accepts it', async () => {
    const key = `sk-${'0123456789abcdef'.repeat(2)}`
    const d = await resolveKey(key, undefined, { fetch: fakeFetch('moonshot.ai') })
    expect(d.provider).toBe('moonshotai')
    expect(d.ambiguous).toBe(false)
    expect(d.candidates[0].reason).toBe('probe')
  })

  it('does not probe exact matches', async () => {
    let calls = 0
    await resolveKey(`gsk_${r(30)}`, undefined, { fetch: async () => { calls++; return { status: 200 } } })
    expect(calls).toBe(0)
  })
})

describe('scanEnv / planRoutes', () => {
  it('finds hinted names and *_API_KEY, skipping empties', () => {
    expect(scanEnv({ OPENAI_API_KEY: 'x', FOO_API_KEY: 'y', HF_TOKEN: 'z', PATH: '/bin', EMPTY_API_KEY: ' ' })
      .map((f) => f.envName)).toEqual(['FOO_API_KEY', 'HF_TOKEN', 'OPENAI_API_KEY'])
  })

  it('maps keys to pi-ai provider routes, honoring overrides', async () => {
    const plan = await planRoutes([
      { envName: 'A_API_KEY', key: `gsk_${r(30)}` },
      { envName: 'B_API_KEY', key: `gsk_${r(31)}` },
      { envName: 'C_API_KEY', key: 'mystery' },
      { envName: 'D_API_KEY', key: 'mystery' },
    ], { overrides: { D_API_KEY: 'openrouter' } })
    expect(plan.providers).toEqual({ groq: { apiKeyEnv: 'A_API_KEY' }, openrouter: { apiKeyEnv: 'D_API_KEY' } })
    expect(plan.unknown).toEqual(['C_API_KEY'])
    expect(plan.routes).toHaveLength(3)
  })
})

describe('route', () => {
  const models: ModelFacts[] = [
    { provider: 'openai', id: 'big', cost: { input: 10, output: 30 }, contextWindow: 200000, reasoning: true, input: ['text', 'image'] },
    { provider: 'deepseek', id: 'cheap', cost: { input: 0.3, output: 1 }, contextWindow: 128000, reasoning: true, input: ['text'] },
    { provider: 'groq', id: 'fast', cost: { input: 0.1, output: 0.1 }, contextWindow: 32000, reasoning: false, input: ['text'] },
  ]

  it('orders by policy', () => {
    expect(route(models, { policy: 'quality' })[0].id).toBe('big')
    expect(route(models, { policy: 'cost' })[0].id).toBe('fast')
    expect(route(models, { policy: 'speed' })[0].id).toBe('fast')
  })

  it('applies constraints, preferences and exclusions', () => {
    expect(route(models, { needsImages: true }).map((m) => m.id)).toEqual(['big'])
    expect(route(models, { minContext: 100000, needsReasoning: true }).map((m) => m.id)).not.toContain('fast')
    expect(route(models, { policy: 'quality', prefer: ['deepseek'] })[0].id).toBe('cheap')
    expect(route(models, { exclude: ['openai', 'groq'] }).map((m) => m.id)).toEqual(['cheap'])
    expect(route(models, { limit: 1 })).toHaveLength(1)
  })
})
