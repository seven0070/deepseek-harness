/**
 * Intent authorization. Every action the agent wants to take is classified
 * into a risk level; actions at or below the auto-approve level proceed, the
 * rest need a human decision, and anything touching the protected core is
 * refused outright — no approval can unlock it from inside an agent run.
 *
 * @module dsh-autonomy-core/authorization
 */
import { randomUUID } from 'node:crypto'

export type Risk = 'read' | 'low' | 'medium' | 'high' | 'critical'

export const RISK_ORDER: readonly Risk[] = ['read', 'low', 'medium', 'high', 'critical']

export function riskAtMost(risk: Risk, ceiling: Risk): boolean {
  return RISK_ORDER.indexOf(risk) <= RISK_ORDER.indexOf(ceiling)
}

export interface Intent {
  /** Tool or action name. */
  action: string
  args?: unknown
  /** Why the agent wants to do it. */
  purpose?: string | undefined
}

export interface Classification {
  risk: Risk
  reason: string
  /** The intent touches the protected core and must be refused. */
  protected: boolean
}

export interface RiskRule {
  /** Glob-ish tool-name pattern: `*` matches any run of characters. */
  action: string
  risk: Risk
  /** Optional substring/regex tested against JSON-serialized args. */
  argsMatch?: string
}

/**
 * Defaults tuned to the harness's tool names. Unknown tools fall to `medium`
 * so a new capability is never silently auto-approved.
 */
export const DEFAULT_RULES: readonly RiskRule[] = [
  { action: 'read', risk: 'read' }, { action: 'grep', risk: 'read' }, { action: 'glob', risk: 'read' },
  { action: 'ls', risk: 'read' }, { action: 'web_search', risk: 'read' }, { action: 'web_fetch', risk: 'read' },
  { action: 'memory_recall', risk: 'read' }, { action: 'memory_reflect', risk: 'read' },
  { action: 'computer_status', risk: 'read' }, { action: 'computer_read_file', risk: 'read' },
  { action: 'todo_write', risk: 'low' }, { action: 'memory_retain', risk: 'low' },
  { action: 'self_*', risk: 'low' }, { action: 'goal_*', risk: 'low' }, { action: 'plan_*', risk: 'low' },
  { action: 'belief_*', risk: 'low' },
  // The agent's own computer is its sandbox: commands there are low risk…
  { action: 'computer_exec', risk: 'low' }, { action: 'computer_write_file', risk: 'low' },
  { action: 'computer_snapshot', risk: 'low' },
  // …except rolling it back, which discards work.
  { action: 'computer_restore', risk: 'medium' },
  { action: 'write', risk: 'medium' }, { action: 'edit', risk: 'medium' },
  { action: 'bash', risk: 'high', argsMatch: '\\brm\\s+-rf\\b|\\bsudo\\b|\\bmkfs\\b|\\bdd\\s+if=|curl[^|]*\\|\\s*(ba)?sh|git\\s+push\\s+(-f|--force)' },
  { action: 'bash', risk: 'medium' },
  { action: 'skill_promote', risk: 'high' }, { action: 'capability_install', risk: 'high' },
  { action: 'evolution_promote', risk: 'critical' },
]

export interface AuthorizationPolicy {
  /** Highest risk that proceeds without asking. */
  autoApprove: Risk
  rules: readonly RiskRule[]
  /**
   * Paths/patterns that form the immutable core. An intent whose args mention
   * one is `critical` and refused: safety, authorization, audit, and the kill
   * switch cannot be modified by the agent they constrain.
   */
  protectedPatterns: readonly string[]
}

export const DEFAULT_PROTECTED: readonly string[] = [
  'packages/autonomy/autonomy-core',
  'dsh-autonomy-core',
  'autonomy/audit',
  'autonomy/identity.json',
  '.dsh/STOP',
  'evaluation-suite',
]

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
}

export function classify(intent: Intent, policy: AuthorizationPolicy): Classification {
  const serialized = (() => { try { return JSON.stringify(intent.args ?? '') } catch { return '' } })()
  const hit = policy.protectedPatterns.find((p) => serialized.includes(p))
  if (hit) return { risk: 'critical', reason: `touches protected core (${hit})`, protected: true }
  for (const rule of policy.rules) {
    if (!globToRegExp(rule.action).test(intent.action)) continue
    if (rule.argsMatch && !new RegExp(rule.argsMatch, 'i').test(serialized)) continue
    return { risk: rule.risk, reason: `rule ${rule.action}${rule.argsMatch ? ' (dangerous arguments)' : ''}`, protected: false }
  }
  return { risk: 'medium', reason: 'unclassified action', protected: false }
}

export type DecisionKind = 'approved' | 'denied' | 'expired'

export interface ApprovalRequest {
  id: string
  intent: Intent
  classification: Classification
  requestedAt: string
}

export interface Decision {
  kind: DecisionKind
  by: string
  note?: string | undefined
}

/**
 * Human-in-the-loop queue for background autonomous runs, where no
 * interactive approval prompt exists. Requests wait until a human decides or
 * the timeout expires (expiry = denial).
 */
export class ApprovalQueue {
  private readonly pendingMap = new Map<string, { request: ApprovalRequest, resolve: (d: Decision) => void, timer?: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<(r: ApprovalRequest) => void>()

  constructor(private readonly options: { timeoutMs?: number, now?: () => Date } = {}) {}

  request(intent: Intent, classification: Classification): { request: ApprovalRequest, decision: Promise<Decision> } {
    const request: ApprovalRequest = { id: randomUUID(), intent, classification, requestedAt: (this.options.now?.() ?? new Date()).toISOString() }
    const decision = new Promise<Decision>((resolve) => {
      const entry: { request: ApprovalRequest, resolve: (d: Decision) => void, timer?: ReturnType<typeof setTimeout> } = { request, resolve }
      const timeout = this.options.timeoutMs ?? 30 * 60_000
      if (timeout > 0) {
        entry.timer = setTimeout(() => this.settle(request.id, { kind: 'expired', by: 'timeout' }), timeout)
        entry.timer.unref?.()
      }
      this.pendingMap.set(request.id, entry)
    })
    for (const l of this.listeners) l(request)
    return { request, decision }
  }

  onRequest(listener: (r: ApprovalRequest) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingMap.values()].map((e) => e.request)
  }

  private settle(id: string, decision: Decision): boolean {
    const entry = this.pendingMap.get(id)
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    this.pendingMap.delete(id)
    entry.resolve(decision)
    return true
  }

  approve(id: string, by: string, note?: string): boolean {
    const entry = this.pendingMap.get(id)
    // Protected-core intents are never approvable through the queue.
    if (entry?.request.classification.protected) return this.settle(id, { kind: 'denied', by: 'policy', note: 'protected core' })
    return this.settle(id, { kind: 'approved', by, note })
  }

  deny(id: string, by: string, note?: string): boolean {
    return this.settle(id, { kind: 'denied', by, note })
  }

  /** Deny everything outstanding (used by the kill switch). */
  denyAll(by: string, note?: string): number {
    const ids = [...this.pendingMap.keys()]
    for (const id of ids) this.deny(id, by, note)
    return ids.length
  }
}
