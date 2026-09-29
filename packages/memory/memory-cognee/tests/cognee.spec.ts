import { expect, it, vi } from 'vitest'
import type { FetchLike } from '@deepseek-ai/dsh-memory'
import { CogneeMemory, textsOf } from '../src/index.ts'

function server(searchReply: unknown = [{ search_result: ['[fact] Paris is in France', 'Rome is in Italy'] }]) {
  const calls: { url: string, body: any, headers: Record<string, string> }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers })
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/search') ? searchReply : { status: 'ok' }) }
  }
  return { calls, fetch }
}

it('adds as multipart, then cognifies once after a debounce', async () => {
  vi.useFakeTimers()
  try {
    const s = server()
    const c = new CogneeMemory({ baseUrl: 'http://c:8000', dataset: 'primary', apiKey: 'k', cognifyDebounceMs: 1000, fetch: s.fetch })
    await c.retain([{ content: 'Paris is in France', kind: 'fact' }])
    await c.retain([{ content: 'Rome is in Italy' }])
    const add = s.calls[0]!
    expect(add.url).toBe('http://c:8000/api/v1/add')
    expect(add.headers['x-api-key']).toBe('k')
    const form = add.body as FormData
    expect(form.get('datasetName')).toBe('primary')
    expect(form.getAll('raw_data')).toEqual(['[fact]\nParis is in France'])
    await vi.advanceTimersByTimeAsync(1500)
    const cognify = s.calls.filter((x) => x.url.endsWith('/cognify'))
    expect(cognify).toHaveLength(1)
    expect(JSON.parse(cognify[0]!.body).datasets).toEqual(['primary'])
    c.dispose()
  } finally {
    vi.useRealTimers()
  }
})

it('recalls and reflects through search', async () => {
  const s = server()
  const c = new CogneeMemory({ baseUrl: 'http://c:8000/', dataset: 'd', fetch: s.fetch })
  const hits = await c.recall('capitals', { limit: 5 })
  expect(hits.map((h) => h.content)).toEqual(['[fact] Paris is in France', 'Rome is in Italy'])
  expect(hits[0]!.kind).toBe('fact')
  const body = JSON.parse(s.calls[0]!.body)
  expect(body).toMatchObject({ query: 'capitals', searchType: 'CHUNKS', datasets: ['d'] })
  expect((await c.reflect('capitals'))?.source).toBe('cognee')
  expect(JSON.parse(s.calls[1]!.body).searchType).toBe('GRAPH_COMPLETION')
})

it('extracts text from varied search payloads', () => {
  expect(textsOf(['a', { text: 'b' }, { content: ['c', ''] }, { summary: 'd' }, 7, null])).toEqual(['a', 'b', 'c', 'd'])
  expect(textsOf({ results: 'x' })).toEqual([])
})
