/**
 * Learned guidelines: the part of the prompt the agent builds itself while
 * chatting. The agent proposes a guideline (add / replace / remove) with a
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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

  constructor(private readonly options: { path?: string | undefined, limits?: Partial<GuidelineLimits>, now?: () => Date } = {}) {}

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
    return v
  }
}
