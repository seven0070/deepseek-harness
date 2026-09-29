/**
 * Kill switch and resource budgets.
 *
 * @module dsh-autonomy-core/control
 */
import { existsSync } from 'node:fs'

export class KillSwitchEngaged extends Error {
  constructor(readonly reason: string) {
    super(`kill switch engaged: ${reason}`)
  }
}

/**
 * One switch stops everything. It exposes an AbortSignal every long-running
 * component should honor, and can also be tripped from outside the process by
 * creating a sentinel file (`touch ~/.dsh/STOP`).
 */
export class KillSwitch {
  private controller = new AbortController()
  private why: string | undefined

  constructor(private readonly sentinel?: string | undefined) {}

  get signal(): AbortSignal {
    this.poll()
    return this.controller.signal
  }

  get engaged(): boolean {
    this.poll()
    return this.why !== undefined
  }

  get reason(): string | undefined {
    return this.why
  }

  private poll(): void {
    if (this.why === undefined && this.sentinel && existsSync(this.sentinel)) this.engage(`sentinel file ${this.sentinel} present`)
  }

  engage(reason: string): void {
    if (this.why !== undefined) return
    this.why = reason
    this.controller.abort(new KillSwitchEngaged(reason))
  }

  /** Owner-only in practice: the plugin exposes no model tool for this. */
  reset(): void {
    this.why = undefined
    this.controller = new AbortController()
  }

  assert(): void {
    if (this.engaged) throw new KillSwitchEngaged(this.why!)
  }
}

export type Resource = 'tokens' | 'usd' | 'actions' | 'wallMs'

export type BudgetLimits = Partial<Record<Resource, number>>

export class BudgetExceeded extends Error {
  constructor(readonly resource: Resource, readonly used: number, readonly limit: number) {
    super(`budget exceeded: ${resource} ${used} / ${limit}`)
  }
}

/**
 * Rolling-window budget. Limits apply per window (default one day); usage
 * resets when the window rolls over. `wallMs` measures time since the window
 * opened, which caps how long an autonomous run can go on.
 */
export class Budget {
  private used: Record<Resource, number> = { tokens: 0, usd: 0, actions: 0, wallMs: 0 }
  private windowStart: number

  constructor(private readonly limits: BudgetLimits, private readonly options: { windowMs?: number, now?: () => number } = {}) {
    this.windowStart = this.now()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private roll(): void {
    const windowMs = this.options.windowMs ?? 86_400_000
    if (this.now() - this.windowStart >= windowMs) {
      this.windowStart = this.now()
      this.used = { tokens: 0, usd: 0, actions: 0, wallMs: 0 }
    }
    this.used.wallMs = this.now() - this.windowStart
  }

  charge(resource: Exclude<Resource, 'wallMs'>, amount: number): void {
    this.roll()
    this.used[resource] += Math.max(0, amount)
  }

  /** @returns the first exhausted resource, if any. */
  exceeded(): BudgetExceeded | undefined {
    this.roll()
    for (const [resource, limit] of Object.entries(this.limits) as [Resource, number][]) {
      if (limit > 0 && this.used[resource] >= limit) return new BudgetExceeded(resource, this.used[resource], limit)
    }
    return undefined
  }

  assert(): void {
    const e = this.exceeded()
    if (e) throw e
  }

  snapshot(): { used: Record<Resource, number>, limits: BudgetLimits, remaining: Partial<Record<Resource, number>> } {
    this.roll()
    const remaining: Partial<Record<Resource, number>> = {}
    for (const [r, limit] of Object.entries(this.limits) as [Resource, number][]) remaining[r] = Math.max(0, limit - this.used[r])
    return { used: { ...this.used }, limits: { ...this.limits }, remaining }
  }
}
