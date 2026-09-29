/**
 * Capability acquisition. The agent can grow new abilities — reusable skills
 * (SKILL.md) or helper scripts — through a fixed pipeline:
 *
 *   propose → test (on the agent's own computer) → owner approval → install
 *
 * Installation is a `high`-risk intent, so it always passes the autonomy-core
 * gate; a proposal that failed its tests cannot be installed at all.
 *
 * @module dsh-learning/capability
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type CapabilityKind = 'skill' | 'script'
export type CapabilityStatus = 'proposed' | 'tested' | 'failed-tests' | 'installed' | 'rejected'

export interface CapabilityProposal {
  id: string
  kind: CapabilityKind
  /** kebab-case identifier. */
  name: string
  description: string
  /** SKILL.md body or script source. */
  content: string
  rationale: string
  /** Shell command run on the agent's computer; exit 0 = pass. */
  test?: string | undefined
  status: CapabilityStatus
  testOutput?: string | undefined
  createdAt: string
}

const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/

export function renderSkill(p: Pick<CapabilityProposal, 'name' | 'description' | 'content'>): string {
  const desc = p.description.replace(/\n/g, ' ').replace(/"/g, '\\"')
  return `---\nname: ${p.name}\ndescription: "${desc}"\n---\n\n${p.content.trim()}\n`
}

export class CapabilityRegistry {
  private readonly proposals = new Map<string, CapabilityProposal>()

  constructor(private readonly options: {
    /** Where skills install; the filesystem skill provider reads `~/.dsh/skills`. */
    skillsDir: string
    scriptsDir: string
    runTest?: ((command: string, files: Record<string, string>) => Promise<{ ok: boolean, output: string }>) | undefined
    now?: () => Date
  }) {}

  propose(input: Omit<CapabilityProposal, 'id' | 'status' | 'createdAt' | 'testOutput'>): CapabilityProposal {
    if (!NAME.test(input.name)) throw new Error('capability: name must be kebab-case (a-z, 0-9, -)')
    if (!input.content.trim()) throw new Error('capability: content is required')
    const p: CapabilityProposal = { ...input, id: randomUUID().slice(0, 8), status: 'proposed', createdAt: (this.options.now?.() ?? new Date()).toISOString() }
    this.proposals.set(p.id, p)
    return p
  }

  get(id: string): CapabilityProposal | undefined {
    return this.proposals.get(id)
  }

  list(): CapabilityProposal[] {
    return [...this.proposals.values()]
  }

  async test(id: string): Promise<CapabilityProposal> {
    const p = this.must(id)
    if (!p.test) {
      p.status = 'tested'
      p.testOutput = 'no test supplied'
      return p
    }
    if (!this.options.runTest) throw new Error('capability: no test runner (enable the agent computer)')
    const file = p.kind === 'skill' ? `capabilities/${p.name}/SKILL.md` : `capabilities/${p.name}`
    const result = await this.options.runTest(p.test, { [file]: p.kind === 'skill' ? renderSkill(p) : p.content })
    p.status = result.ok ? 'tested' : 'failed-tests'
    p.testOutput = result.output.slice(-4000)
    return p
  }

  /** Caller must have authorized `capability_install` first. */
  async install(id: string): Promise<{ proposal: CapabilityProposal, path: string }> {
    const p = this.must(id)
    if (p.status !== 'tested') throw new Error(`capability: cannot install a ${p.status} proposal; test it first`)
    let path: string
    if (p.kind === 'skill') {
      const dir = join(this.options.skillsDir, p.name)
      await mkdir(dir, { recursive: true })
      path = join(dir, 'SKILL.md')
      await writeFile(path, renderSkill(p))
    } else {
      await mkdir(this.options.scriptsDir, { recursive: true })
      path = join(this.options.scriptsDir, p.name)
      await writeFile(path, p.content, { mode: 0o755 })
    }
    p.status = 'installed'
    return { proposal: p, path }
  }

  reject(id: string): CapabilityProposal {
    const p = this.must(id)
    p.status = 'rejected'
    return p
  }

  private must(id: string): CapabilityProposal {
    const p = this.proposals.get(id)
    if (!p) throw new Error(`capability: no proposal ${id}`)
    return p
  }
}
