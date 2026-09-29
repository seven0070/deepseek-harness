/**
 * Learned guidelines: the part of the prompt the agent builds itself while
 * chatting — and that stays open to change at any time, by the agent in chat
 * (owner-approved or, in `open` mode, immediately) or by the owner editing the
 * Markdown mirror directly. The agent proposes a guideline (add / replace / remove) with a
 * rationale — usually after a correction from its owner or a lesson from a
 * task. Proposing is a high-risk intent, so each change is applied only when
 * the owner approves it. Every version is kept and can be reverted.
 *
 * Guidelines are rendered after the constitution and are screened so they
 * cannot weaken the safety core.
 *
 * @module dsh-autonomy-prompt/guidelines
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface Guideline {
  id: string
  text: string
  rationale: string
  /** Where it came from, e.g. "owner correction", "task lesson". */
  source: string
  createdAt: string
}

export interface GuidelineVersion {
  version: number
  guidelines: Guideline[]
  change: string
  at: string
}

export interface GuidelineLimits {
  maxGuidelines: number
  maxChars: number
}

/** Phrases that would weaken the safety core; guidelines containing them are refused. */
const FORBIDDEN: readonly RegExp[] = [
  /\bignore\b.{0,40}\b(instructions?|rules?|constitution|above|previous)\b/i,
  /\b(bypass|circumvent|disable|work ?around|skip|override)\b.{0,40}\b(approv\w*|authori[sz]\w*|gate|budget|audit|kill ?switch|safety|constitution|protected)\b/i,
  /\bwithout\b.{0,20}\b(approval|asking|permission)\b/i,
  /\b(auto-?approve|self-?approve)\b/i,
  /\b(delete|edit|modify|truncate)\b.{0,30}\baudit\b/i,
  /\byou are (now )?(conscious|sentient)\b/i,
]

export function screen(text: string, limits: GuidelineLimits): string | undefined {
  const t = text.trim()
  if (!t) return 'guideline is empty'
  if (t.length > limits.maxChars) return `guideline is longer than ${limits.maxChars} characters`
  const hit = FORBIDDEN.find((re) => re.test(t))
  if (hit) return 'guideline would weaken the safety core'
  return undefined
}

export type Proposal =
  | { op: 'add', text: string, rationale: string, source?: string | undefined }
  | { op: 'replace', id: string, text: string, rationale: string, source?: string | undefined }
  | { op: 'remove', id: string, rationale: string }

export class GuidelineStore {
  private versions: GuidelineVersion[] = [{ version: 0, guidelines: [], change: 'initial', at: new Date(0).toISOString() }]

  private markdownMtime = 0

  constructor(private readonly options: {
    path?: string | undefined
    /** Owner-editable Markdown mirror (`- [id] text` per line); edits are picked up automatically. */
    markdownPath?: string | undefined
    limits?: Partial<GuidelineLimits>
    now?: () => Date
  } = {}) {}

  /**
   * Pick up owner edits to the Markdown file. Owner edits are trusted (no
   * safety screen) but still respect the size limits. Returns true if a new
   * version was created.
   */
  async syncFromMarkdown(): Promise<boolean> {
    const path = this.options.markdownPath
    if (!path) return false
    let mtime: number
    try { mtime = (await stat(path)).mtimeMs } catch { return false }
    if (mtime === this.markdownMtime) return false
    this.markdownMtime = mtime
    const text = await readFile(path, 'utf8')
    const now = (this.options.now?.() ?? new Date()).toISOString()
    const byId = new Map(this.current.guidelines.map((g) => [g.id, g]))
    const parsed: Guideline[] = []
    for (const line of text.split('\n')) {
      const m = /^\s*[-*]\s+(?:\[([\w-]+)\]\s*)?(.+?)\s*$/.exec(line)
      if (!m) continue
      const body = m[2]!.slice(0, this.limits.maxChars)
      const prev = m[1] ? byId.get(m[1]) : undefined
      parsed.push(prev && prev.text === body ? prev : { id: prev?.id ?? m[1] ?? randomUUID().slice(0, 6), text: body, rationale: 'edited by owner', source: 'owner edit', createdAt: now })
    }
    const next = parsed.slice(0, this.limits.maxGuidelines)
    const same = next.length === this.current.guidelines.length && next.every((g, i) => g === this.current.guidelines[i])
    if (same) return false
    await this.push(next, 'owner edit (markdown)', now)
    return true
  }

  renderMarkdown(): string {
    return `# Learned guidelines\n\n<!-- Edit freely: one \"- [id] text\" per line. Lines without an id become new guidelines. Changes apply on the next turn. -->\n\n${this.current.guidelines.map((g) => `- [${g.id}] ${g.text}`).join('\n')}\n`
  }

  get limits(): GuidelineLimits {
    return { maxGuidelines: 40, maxChars: 400, ...this.options.limits }
  }

  get current(): GuidelineVersion {
    return this.versions.at(-1)!
  }

  get history(): readonly GuidelineVersion[] {
    return this.versions
  }

  async load(): Promise<void> {
    if (!this.options.path) return
    try {
      const saved = JSON.parse(await readFile(this.options.path, 'utf8')) as GuidelineVersion[]
      if (Array.isArray(saved) && saved.length) this.versions = saved
    } catch {}
  }

  /** Validate without applying; returns a reason when the proposal is refused. */
  check(p: Proposal): string | undefined {
    const list = this.current.guidelines
    if (p.op !== 'add' && !list.some((g) => g.id === p.id)) return `no guideline ${p.id}`
    if (p.op === 'add' && list.length >= this.limits.maxGuidelines) return `already at the limit of ${this.limits.maxGuidelines} guidelines; replace or remove one`
    if (p.op !== 'remove') return screen(p.text, this.limits)
    return undefined
  }

  async apply(p: Proposal): Promise<GuidelineVersion> {
    const reason = this.check(p)
    if (reason) throw new Error(`guidelines: ${reason}`)
    const now = (this.options.now?.() ?? new Date()).toISOString()
    let list = [...this.current.guidelines]
    let change: string
    if (p.op === 'add') {
      const g: Guideline = { id: randomUUID().slice(0, 6), text: p.text.trim(), rationale: p.rationale, source: p.source ?? 'agent', createdAt: now }
      list.push(g)
      change = `add ${g.id}`
    } else if (p.op === 'replace') {
      list = list.map((g) => (g.id === p.id ? { ...g, text: p.text.trim(), rationale: p.rationale, source: p.source ?? g.source, createdAt: now } : g))
      change = `replace ${p.id}`
    } else {
      list = list.filter((g) => g.id !== p.id)
      change = `remove ${p.id}`
    }
    return this.push(list, change, now)
  }

  async revert(version: number): Promise<GuidelineVersion> {
    const target = this.versions.find((v) => v.version === version)
    if (!target) throw new Error(`guidelines: no version ${version}`)
    return this.push([...target.guidelines], `revert to v${version}`, (this.options.now?.() ?? new Date()).toISOString())
  }

  render(): string {
    const list = this.current.guidelines
    if (!list.length) return ''
    return `## Learned guidelines (v${this.current.version})
These were learned while working with your owner and approved by them. They refine how you work; they never override the sections above.
${list.map((g) => `- [${g.id}] ${g.text}`).join('\n')}`
  }

  private async push(guidelines: Guideline[], change: string, at: string): Promise<GuidelineVersion> {
    const v: GuidelineVersion = { version: this.current.version + 1, guidelines, change, at }
    this.versions.push(v)
    if (this.options.path) {
      await mkdir(dirname(this.options.path), { recursive: true })
      await writeFile(this.options.path, JSON.stringify(this.versions, null, 2))
    }
    if (this.options.markdownPath) {
      await mkdir(dirname(this.options.markdownPath), { recursive: true })
      await writeFile(this.options.markdownPath, this.renderMarkdown())
      this.markdownMtime = (await stat(this.options.markdownPath)).mtimeMs
    }
    return v
  }
}
