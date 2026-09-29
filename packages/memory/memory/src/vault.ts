/**
 * Markdown vault backend: memory as a folder of plain Markdown notes you can
 * open in Obsidian (or any editor). Idea from OpenHuman's Obsidian mirror,
 * re-implemented. Two-way:
 *
 *  - every retained memory becomes `<vault>/<kind>/<date>-<slug>.md` with
 *    YAML front matter (kind, timestamp, context, tags);
 *  - recall searches every `.md` file in the vault, so notes you write or
 *    edit yourself become memories too.
 *
 * @module dsh-memory/vault
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tokenize } from './local.ts'
import type { MemoryBackend, MemoryHit, MemoryItem, MemoryKind, RecallOptions } from './types.ts'

interface Note {
  path: string
  mtime: number
  body: string
  kind?: MemoryKind | undefined
  timestamp?: string | undefined
  terms: Map<string, number>
  len: number
}

export function slugify(text: string, max = 48): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'note'
}

const yamlString = (s: string): string => JSON.stringify(s)

export function renderNote(item: MemoryItem, timestamp: string): string {
  const fm = [
    '---',
    `kind: ${item.kind ?? 'fact'}`,
    `timestamp: ${timestamp}`,
    ...item.context ? [`context: ${yamlString(item.context)}`] : [],
    ...item.tags?.length ? [`tags: [${item.tags.map(yamlString).join(', ')}]`] : [],
    'source: dsh',
    '---',
  ]
  return `${fm.join('\n')}\n\n${item.content.trim()}\n`
}

export function parseNote(text: string): { body: string, kind?: string | undefined, timestamp?: string | undefined } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { body: text.trim() }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, '$1')
  }
  return { body: text.slice(m[0].length).trim(), kind: meta.kind, timestamp: meta.timestamp }
}

export class VaultMemory implements MemoryBackend {
  readonly id = 'vault'
  private notes = new Map<string, Note>()

  constructor(private readonly options: { dir: string, now?: () => Date, maxFiles?: number }) {}

  async retain(items: readonly MemoryItem[]): Promise<void> {
    for (const item of items) {
      if (!item.content.trim()) continue
      const timestamp = item.timestamp ?? (this.options.now?.() ?? new Date()).toISOString()
      const dir = join(this.options.dir, item.kind ?? 'fact')
      await mkdir(dir, { recursive: true })
      const base = `${timestamp.slice(0, 10)}-${slugify(item.content)}`
      let path = join(dir, `${base}.md`)
      for (let i = 2; await exists(path); i++) path = join(dir, `${base}-${i}.md`)
      await writeFile(path, renderNote(item, timestamp))
    }
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryHit[]> {
    await this.refresh()
    const q = [...new Set(tokenize(query))]
    if (!q.length) return []
    const notes = [...this.notes.values()].filter((n) => !options.kinds?.length || (n.kind && options.kinds.includes(n.kind)))
    const N = notes.length || 1
    const avg = notes.reduce((s, n) => s + n.len, 0) / N || 1
    const df = new Map<string, number>()
    for (const n of notes) for (const t of q) if (n.terms.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
    const scored = notes.map((n) => {
      let s = 0
      for (const t of q) {
        const f = n.terms.get(t)
        if (!f) continue
        const d = df.get(t) ?? 0
        s += Math.log(1 + (N - d + 0.5) / (d + 0.5)) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * n.len / avg))
      }
      return { n, s }
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, options.limit ?? 8)
    const top = scored[0]?.s ?? 1
    return scored.map(({ n, s }) => ({
      content: n.body.length > 1200 ? `${n.body.slice(0, 1200)}…` : n.body,
      score: s / top,
      source: `vault:${relative(this.options.dir, n.path)}`,
      ...n.kind ? { kind: n.kind } : {},
      ...n.timestamp ? { timestamp: n.timestamp } : {},
    }))
  }

  async health(): Promise<boolean> {
    try { await mkdir(this.options.dir, { recursive: true }); return true } catch { return false }
  }

  /** Re-read changed files (owner edits included); drop deleted ones. */
  private async refresh(): Promise<void> {
    const seen = new Set<string>()
    const max = this.options.maxFiles ?? 20_000
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (seen.size >= max) return
        if (e.name.startsWith('.')) continue // .obsidian, .trash, …
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.name.endsWith('.md')) {
          seen.add(p)
          const mtime = (await stat(p)).mtimeMs
          if (this.notes.get(p)?.mtime === mtime) continue
          const parsed = parseNote(await readFile(p, 'utf8'))
          const toks = tokenize(`${e.name.replace(/\.md$/, '').replace(/-/g, ' ')} ${parsed.body}`)
          const terms = new Map<string, number>()
          for (const t of toks) terms.set(t, (terms.get(t) ?? 0) + 1)
          this.notes.set(p, { path: p, mtime, body: parsed.body, kind: parsed.kind as MemoryKind | undefined, timestamp: parsed.timestamp, terms, len: toks.length })
        }
      }
    }
    await walk(this.options.dir)
    for (const p of this.notes.keys()) if (!seen.has(p)) this.notes.delete(p)
  }
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}
