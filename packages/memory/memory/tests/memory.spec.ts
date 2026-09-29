import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalMemory, MemoryService, tokenize } from '../src/index.ts'
import type { MemoryBackend } from '../src/index.ts'

describe('LocalMemory', () => {
  it('ranks by keyword relevance and filters by kind', async () => {
    const m = new LocalMemory()
    await m.retain([
      { content: 'The user prefers TypeScript over Python for tooling', kind: 'fact' },
      { content: 'Deploying with Docker compose failed because port 8080 was taken', kind: 'experience' },
      { content: 'I work best by writing tests first', kind: 'self' },
      { content: '   ' },
    ])
    expect(m.size).toBe(3)
    const hits = await m.recall('what language does the user prefer typescript')
    expect(hits[0]!.content).toContain('TypeScript')
    expect(hits[0]!.score).toBe(1)
    expect(await m.recall('docker port', { kinds: ['fact'] })).toEqual([])
    expect((await m.recall('docker port', { kinds: ['experience'] }))[0]!.kind).toBe('experience')
    expect(await m.recall('the and of')).toEqual([])
  })

  it('persists to JSON Lines and reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mem-'))
    const path = join(dir, 'nested', 'm.jsonl')
    await new LocalMemory({ path }).retain([{ content: 'Bengaluru is the user city', kind: 'fact' }])
    expect(await readFile(path, 'utf8')).toContain('Bengaluru')
    const again = new LocalMemory({ path })
    expect((await again.recall('bengaluru'))[0]!.content).toContain('Bengaluru')
  })

  it('tokenizes unicode', () => {
    expect(tokenize('Hello, 世界 café!')).toEqual(['hello', '世界', 'café'])
  })
})

describe('MemoryService', () => {
  const backend = (id: string, over: Partial<MemoryBackend> = {}): MemoryBackend & { stored: string[] } => {
    const stored: string[] = []
    return {
      id,
      stored,
      retain: async (items) => { stored.push(...items.map((i) => i.content)) },
      recall: async () => stored.map((content, i) => ({ content, score: 1 - i * 0.1, source: id })),
      ...over,
    }
  }

  it('fans out retain and merges / dedupes recall with an agreement bonus', async () => {
    const svc = new MemoryService()
    const a = backend('a')
    const b = backend('b')
    svc.register(a)
    svc.register(b)
    expect(await svc.retain([{ content: 'Same memory.' }, { content: '' }])).toEqual([])
    expect(a.stored).toEqual(['Same memory.'])
    expect(b.stored).toEqual(['Same memory.'])
    const { hits } = await svc.recall('x')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.score).toBeCloseTo(1.1)
  })

  it('skips failing and slow backends instead of failing', async () => {
    const errors: string[] = []
    const svc = new MemoryService({ timeoutMs: 50, onError: (id, op) => errors.push(`${id}:${op}`) })
    const good = backend('good')
    svc.register(good)
    svc.register(backend('broken', { retain: async () => { throw new Error('down') }, recall: async () => { throw new Error('down') } }))
    svc.register(backend('slow', { recall: () => new Promise(() => {}) }))
    expect(await svc.retain([{ content: 'hello' }])).toEqual(['broken'])
    const result = await svc.recall('hello')
    expect(result.hits.map((h) => h.source)).toContain('good')
    expect(result.failed).toEqual(['broken', 'slow'])
    expect(errors).toEqual(expect.arrayContaining(['broken:retain', 'broken:recall', 'slow:recall']))
  })

  it('reflects through a capable backend, else summarizes recall', async () => {
    const svc = new MemoryService()
    const plain = backend('plain')
    svc.register(plain)
    await svc.retain([{ content: 'fact one' }])
    expect(await svc.reflect('q')).toEqual({ answer: '- fact one', source: 'recall' })
    svc.register(backend('smart', { reflect: async () => ({ answer: 'synthesized', source: 'smart' }) }))
    expect((await svc.reflect('q')).answer).toBe('synthesized')
  })

  it('rejects duplicate ids and unregisters', async () => {
    const svc = new MemoryService()
    const off = svc.register(backend('a'))
    expect(() => svc.register(backend('a'))).toThrow(/already registered/)
    off()
    expect(svc.list()).toEqual([])
  })
})
