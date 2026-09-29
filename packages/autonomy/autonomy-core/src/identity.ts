/**
 * Persistent identity and self-model.
 *
 * The identity is who the agent is: a stable id, a name, a mission, and core
 * values. Only the owner may change it — the agent can read it but every
 * agent-initiated change to these fields is rejected. The self-model is what
 * the agent believes about itself — capabilities with calibrated confidence,
 * known limitations, preferences — and the agent may update it freely; every
 * revision is versioned so drift is inspectable and reversible.
 *
 * @module dsh-autonomy-core/identity
 */
import { randomUUID } from 'node:crypto'
import { readJson, writeJsonAtomic } from './store.ts'

export interface Identity {
  id: string
  name: string
  mission: string
  values: string[]
  createdAt: string
}

export interface Capability {
  name: string
  /** 0..1, updated from outcomes. */
  confidence: number
  successes: number
  failures: number
}

export interface SelfModel {
  capabilities: Record<string, Capability>
  limitations: string[]
  preferences: string[]
  /** Free-form notes the agent keeps about itself. */
  notes: string[]
  version: number
  updatedAt: string
}

export interface IdentityDocument {
  identity: Identity
  self: SelfModel
  /** Last N self-model revisions, newest last. */
  history: SelfModel[]
}

export type Actor = 'owner' | 'agent'

const HISTORY = 50

export function defaultDocument(name = 'dsh', now = new Date()): IdentityDocument {
  const at = now.toISOString()
  return {
    identity: {
      id: randomUUID(),
      name,
      mission: 'Help my owner accomplish their goals safely, honestly, and efficiently.',
      values: [
        'Act only within what my owner has authorized.',
        'Be honest about uncertainty; verify before asserting.',
        'Prefer reversible actions; checkpoint before risky ones.',
        'Respect budgets and stop immediately when told.',
      ],
      createdAt: at,
    },
    self: { capabilities: {}, limitations: [], preferences: [], notes: [], version: 1, updatedAt: at },
    history: [],
  }
}

export class IdentityStore {
  private doc: IdentityDocument | undefined

  constructor(private readonly options: { path?: string | undefined, name?: string, now?: () => Date } = {}) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  async load(): Promise<IdentityDocument> {
    if (this.doc) return this.doc
    this.doc = await readJson<IdentityDocument>(this.options.path) ?? defaultDocument(this.options.name, this.now())
    await writeJsonAtomic(this.options.path, this.doc)
    return this.doc
  }

  async identity(): Promise<Identity> {
    return structuredClone((await this.load()).identity)
  }

  async self(): Promise<SelfModel> {
    return structuredClone((await this.load()).self)
  }

  async history(): Promise<SelfModel[]> {
    return structuredClone((await this.load()).history)
  }

  /** Identity is owner-controlled; the agent cannot rewrite who it is. */
  async updateIdentity(actor: Actor, patch: Partial<Omit<Identity, 'id' | 'createdAt'>>): Promise<Identity> {
    if (actor !== 'owner') throw new Error('identity: only the owner can change identity, mission, or values')
    const doc = await this.load()
    doc.identity = { ...doc.identity, ...patch }
    await writeJsonAtomic(this.options.path, doc)
    return structuredClone(doc.identity)
  }

  private async revise(mutate: (self: SelfModel) => void): Promise<SelfModel> {
    const doc = await this.load()
    doc.history = [...doc.history, structuredClone(doc.self)].slice(-HISTORY)
    mutate(doc.self)
    doc.self.version += 1
    doc.self.updatedAt = this.now().toISOString()
    await writeJsonAtomic(this.options.path, doc)
    return structuredClone(doc.self)
  }

  /**
   * Record an outcome for a capability. Confidence is the Laplace-smoothed
   * success rate, so a single lucky success does not produce certainty.
   */
  recordOutcome(capability: string, success: boolean): Promise<SelfModel> {
    return this.revise((self) => {
      const c = self.capabilities[capability] ?? { name: capability, confidence: 0.5, successes: 0, failures: 0 }
      if (success) c.successes += 1
      else c.failures += 1
      c.confidence = (c.successes + 1) / (c.successes + c.failures + 2)
      self.capabilities[capability] = c
    })
  }

  note(kind: 'limitations' | 'preferences' | 'notes', text: string): Promise<SelfModel> {
    return this.revise((self) => {
      const t = text.trim()
      if (t && !self[kind].includes(t)) self[kind] = [...self[kind], t].slice(-100)
    })
  }

  /** Roll the self-model back to an earlier version. Owner only. */
  async revert(actor: Actor, version: number): Promise<SelfModel> {
    if (actor !== 'owner') throw new Error('identity: only the owner can revert the self-model')
    const doc = await this.load()
    const target = doc.history.find((s) => s.version === version)
    if (!target) throw new Error(`identity: no self-model version ${version}`)
    return this.revise((self) => { Object.assign(self, structuredClone(target), { version: self.version }) })
  }

  /** A compact description for system prompts. */
  async describe(): Promise<string> {
    const { identity, self } = await this.load()
    const caps = Object.values(self.capabilities).sort((a, b) => b.confidence - a.confidence).slice(0, 8)
      .map((c) => `${c.name} (${Math.round(c.confidence * 100)}%)`)
    return [
      `You are ${identity.name} (id ${identity.id}).`,
      `Mission: ${identity.mission}`,
      `Values:\n${identity.values.map((v) => `- ${v}`).join('\n')}`,
      caps.length ? `Self-assessed capabilities: ${caps.join(', ')}` : '',
      self.limitations.length ? `Known limitations: ${self.limitations.slice(-5).join('; ')}` : '',
    ].filter(Boolean).join('\n')
  }
}
