import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Memory from '@deepseek-ai/dsh-memory'
import type { FetchLike } from '@deepseek-ai/dsh-memory'
import * as Hindsight from '../src/index.ts'

function server() {
  const calls: { url: string, body: any, headers: Record<string, string> }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, headers: init.headers })
    const reply = url.endsWith('/memories/recall')
      ? { results: [{ text: 'Alice works at Google', fact_type: 'world' }, { text: 'I fixed the build', fact_type: 'experience' }] }
      : url.endsWith('/reflect') ? { text: 'Alice is an engineer at Google.' } : { success: true }
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) }
  }
  return { calls, fetch }
}

it('speaks the Hindsight REST API', async () => {
  const s = server()
  const h = new Hindsight.HindsightMemory({ baseUrl: 'http://h:8888/', bank: 'agent one', apiKey: 'k', fetch: s.fetch })
  await h.retain([{ content: 'Alice works at Google', kind: 'fact', context: 'intro', timestamp: '2026-09-29T00:00:00Z' }])
  expect(s.calls[0]!.url).toBe('http://h:8888/v1/default/banks/agent%20one/memories')
  expect(s.calls[0]!.headers.authorization).toBe('Bearer k')
  expect(s.calls[0]!.body.items[0]).toEqual({ content: 'Alice works at Google', context: 'kind: fact; intro', timestamp: '2026-09-29T00:00:00Z' })
  const hits = await h.recall('alice', { limit: 5 })
  expect(hits.map((x) => [x.content, x.kind])).toEqual([['Alice works at Google', 'fact'], ['I fixed the build', 'experience']])
  expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  expect((await h.recall('alice', { kinds: ['experience'] })).map((x) => x.content)).toEqual(['I fixed the build'])
  expect(await h.reflect('alice')).toEqual({ answer: 'Alice is an engineer at Google.', source: 'hindsight' })
})

it('registers onto ctx.memory and unregisters on dispose', async () => {
  const s = server()
  const ctx = new Context()
  await ctx.plugin(Memory, { tools: false })
  const fiber = await ctx.plugin(Hindsight, { fetch: s.fetch })
  expect(ctx.memory.list().sort()).toEqual(['hindsight', 'local'])
  expect((await ctx.memory.reflect('alice')).source).toBe('hindsight')
  await fiber.dispose()
  expect(ctx.memory.list()).toEqual(['local'])
  await ctx.fiber.dispose()
})
