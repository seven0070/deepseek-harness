/**
 * Plans and recovery. A plan is a DAG of steps for one goal. A step may name a
 * concrete tool action (executed directly) or be a free-form task handed to a
 * delegate (e.g. a subagent). Each step can carry a check — a tool action
 * whose success verifies the step actually achieved its effect.
 *
 * @module dsh-executive/plan
 */

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface ToolAction {
  tool: string
  args: Record<string, unknown>
}

export interface Step {
  id: string
  description: string
  action?: ToolAction | undefined
  /** Verification action; the step only counts as done if this succeeds. */
  check?: ToolAction | undefined
  dependsOn: string[]
  status: StepStatus
  attempts: number
  maxAttempts: number
  lastError?: string | undefined
  result?: string | undefined
}

export interface Plan {
  goalId: string
  steps: Step[]
  createdAt: string
  revision: number
}

export function makePlan(goalId: string, steps: (Partial<Step> & { id: string, description: string })[], now = new Date()): Plan {
  const ids = new Set(steps.map((s) => s.id))
  if (ids.size !== steps.length) throw new Error('plan: duplicate step ids')
  for (const s of steps) {
    for (const d of s.dependsOn ?? []) if (!ids.has(d)) throw new Error(`plan: step ${s.id} depends on unknown ${d}`)
  }
  const plan: Plan = {
    goalId,
    createdAt: now.toISOString(),
    revision: 1,
    steps: steps.map((s) => ({ dependsOn: [], status: 'pending', attempts: 0, maxAttempts: 3, ...s })),
  }
  if (hasCycle(plan)) throw new Error('plan: dependency cycle')
  return plan
}

function hasCycle(plan: Plan): boolean {
  const byId = new Map(plan.steps.map((s) => [s.id, s]))
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true
    if (state.get(id) === 2) return false
    state.set(id, 1)
    for (const d of byId.get(id)!.dependsOn) if (visit(d)) return true
    state.set(id, 2)
    return false
  }
  return plan.steps.some((s) => visit(s.id))
}

/** Steps whose dependencies are all done and that can still be attempted. */
export function readySteps(plan: Plan): Step[] {
  const done = new Set(plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').map((s) => s.id))
  return plan.steps.filter((s) => s.status === 'pending' && s.dependsOn.every((d) => done.has(d)))
}

export function planOutcome(plan: Plan): 'done' | 'failed' | 'in-progress' {
  if (plan.steps.every((s) => s.status === 'done' || s.status === 'skipped')) return 'done'
  const failed = new Set(plan.steps.filter((s) => s.status === 'failed').map((s) => s.id))
  if (!failed.size) return 'in-progress'
  // Failed if nothing can make progress any more.
  const blocked = (s: Step, seen = new Set<string>()): boolean => {
    if (failed.has(s.id)) return true
    if (seen.has(s.id)) return false
    seen.add(s.id)
    return s.dependsOn.some((d) => blocked(plan.steps.find((x) => x.id === d)!, seen))
  }
  return plan.steps.filter((s) => s.status === 'pending').every((s) => blocked(s)) ? 'failed' : 'in-progress'
}

/** Transient failures are retried; permanent ones fail the step immediately. */
export function isTransient(message: string): boolean {
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|rate.?limit|429|50[234]|temporar|unavailable|try again/i.test(message)
    && !/denied|not approved|refused|protected|budget|kill switch|stopped/i.test(message)
}

export function backoffMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
}

/**
 * Per-action circuit breaker: after `threshold` consecutive failures an action
 * is skipped for `coolMs`, so the loop stops hammering a broken tool.
 */
export class CircuitBreaker {
  private readonly failures = new Map<string, { count: number, openedAt?: number }>()

  constructor(private readonly threshold = 3, private readonly coolMs = 5 * 60_000, private readonly now: () => number = Date.now) {}

  open(action: string): boolean {
    const f = this.failures.get(action)
    if (f?.openedAt === undefined) return false
    if (this.now() - f.openedAt >= this.coolMs) {
      this.failures.delete(action)
      return false
    }
    return true
  }

  success(action: string): void {
    this.failures.delete(action)
  }

  failure(action: string): void {
    const f = this.failures.get(action) ?? { count: 0 }
    f.count += 1
    if (f.count >= this.threshold) f.openedAt = this.now()
    this.failures.set(action, f)
  }
}
