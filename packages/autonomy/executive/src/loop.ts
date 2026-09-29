/**
 * The autonomous executive loop. One `tick()` does one unit of work:
 *
 *   stop? → pick goal → ensure plan → pick ready step → recall memory →
 *   authorize → act → verify → learn (world, self-model, memory) → checkpoint
 *
 * Everything external is injected, so the loop is deterministic under test
 * and the plugin decides what "act" and "delegate" mean in production.
 *
 * @module dsh-executive/loop
 */
import type { AutonomyCore } from '@deepseek-ai/dsh-autonomy-core'
import type { MemoryService } from '@deepseek-ai/dsh-memory'
import { GoalTree } from './goals.ts'
import type { Goal, GoalState } from './goals.ts'
import { CircuitBreaker, isTransient, planOutcome, readySteps } from './plan.ts'
import type { Plan, Step, ToolAction } from './plan.ts'
import { WorldModel } from './world.ts'
import type { WorldState } from './world.ts'

export interface ActResult {
  ok: boolean
  text: string
}

export interface ExecutiveState {
  goals: GoalState
  world: WorldState
  plans: Record<string, Plan>
  ticks: number
}

export interface ExecutiveDeps {
  core: AutonomyCore
  memory?: MemoryService | undefined
  /** Run one tool action; `callId` has been pre-authorized. */
  act(action: ToolAction, callId: string, signal: AbortSignal): Promise<ActResult>
  /** Handle a free-form step (e.g. via a subagent). Absent = such steps block. */
  delegate?: ((step: Step, goal: Goal, context: string, signal: AbortSignal) => Promise<ActResult>) | undefined
  /** Propose a plan for a goal with none. Absent = goal waits for a plan. */
  planner?: ((goal: Goal, context: string, signal: AbortSignal) => Promise<Plan | undefined>) | undefined
  save?: ((state: ExecutiveState) => Promise<void>) | undefined
  now?: () => Date
}

export type TickReport =
  | { kind: 'stopped', reason: string }
  | { kind: 'idle', reason: string }
  | { kind: 'waiting', goalId: string, reason: string }
  | { kind: 'worked', goalId: string, stepId: string, ok: boolean, detail: string }
  | { kind: 'goal-finished', goalId: string, outcome: 'done' | 'failed' }

let callCounter = 0

export class ExecutiveLoop {
  readonly goals: GoalTree
  readonly world: WorldModel
  readonly plans: Map<string, Plan>
  private ticks: number
  private readonly breaker = new CircuitBreaker()
  private running: AbortController | undefined

  constructor(private readonly deps: ExecutiveDeps, state?: Partial<ExecutiveState>) {
    const now = deps.now ?? (() => new Date())
    this.goals = new GoalTree(state?.goals ?? { goals: [] }, now)
    this.world = new WorldModel(state?.world ?? { beliefs: [], predictions: [] }, { now })
    this.plans = new Map(Object.entries(state?.plans ?? {}))
    this.ticks = state?.ticks ?? 0
  }

  toJSON(): ExecutiveState {
    return { goals: this.goals.toJSON(), world: this.world.toJSON(), plans: Object.fromEntries(this.plans), ticks: this.ticks }
  }

  private async checkpoint(): Promise<void> {
    await this.deps.save?.(this.toJSON())
  }

  setPlan(plan: Plan): void {
    const prior = this.plans.get(plan.goalId)
    this.plans.set(plan.goalId, prior ? { ...plan, revision: prior.revision + 1 } : plan)
  }

  private async context(goal: Goal, step?: Step): Promise<string> {
    if (!this.deps.memory) return ''
    const query = [goal.title, step?.description].filter(Boolean).join(' — ')
    const { hits } = await this.deps.memory.recall(query, { limit: 5 }).catch(() => ({ hits: [] }))
    return hits.map((h) => `- ${h.content}`).join('\n')
  }

  private async runAction(action: ToolAction, purpose: string, signal: AbortSignal): Promise<ActResult> {
    if (this.breaker.open(action.tool)) return { ok: false, text: `circuit open for ${action.tool}; cooling down` }
    const auth = await this.deps.core.authorize({ action: action.tool, args: action.args, purpose }, { signal, interactive: false })
    if (auth.allowed !== true) return { ok: false, text: auth.allowed === 'ask' ? 'needs approval' : auth.reason }
    const callId = `exec-${Date.now().toString(36)}-${++callCounter}`
    this.deps.core.preAuthorize(callId)
    try {
      const result = await this.deps.act(action, callId, signal)
      if (result.ok) this.breaker.success(action.tool)
      else this.breaker.failure(action.tool)
      return result
    } catch (error) {
      this.breaker.failure(action.tool)
      return { ok: false, text: String((error as Error)?.message ?? error) }
    }
  }

  async tick(signal: AbortSignal = new AbortController().signal): Promise<TickReport> {
    const { core } = this.deps
    const stop = core.killSwitch.engaged ? `kill switch: ${core.killSwitch.reason}` : core.budget.exceeded()?.message
    if (stop) return { kind: 'stopped', reason: stop }
    this.ticks += 1
    const merged = AbortSignal.any([signal, core.killSwitch.signal])

    const goal = this.goals.next()
    if (!goal) return { kind: 'idle', reason: 'no active goals' }

    let plan = this.plans.get(goal.id)
    if (!plan) {
      if (!this.deps.planner) return { kind: 'waiting', goalId: goal.id, reason: 'no plan; add one with plan_set' }
      plan = await this.deps.planner(goal, await this.context(goal), merged)
      if (!plan) return { kind: 'waiting', goalId: goal.id, reason: 'planner produced no plan' }
      this.setPlan(plan)
      plan = this.plans.get(goal.id)!
    }

    const outcome = planOutcome(plan)
    if (outcome !== 'in-progress') {
      this.goals.update('agent', goal.id, { status: outcome === 'done' ? 'done' : 'blocked', note: `plan ${outcome}` })
      await core.audit.record('agent', 'goal-finished', { goal: goal.id, outcome })
      await this.deps.memory?.retain([{ kind: 'experience', content: `Goal "${goal.title}" ${outcome === 'done' ? 'completed' : 'failed'} after ${plan.steps.length} steps.`, context: goal.id }]).catch(() => undefined)
      await this.checkpoint()
      return { kind: 'goal-finished', goalId: goal.id, outcome }
    }

    const step = readySteps(plan)[0]
    if (!step) return { kind: 'waiting', goalId: goal.id, reason: 'no step is ready (running or blocked)' }

    step.status = 'running'
    step.attempts += 1
    const context = await this.context(goal, step)
    let result: ActResult
    if (step.action) result = await this.runAction(step.action, step.description, merged)
    else if (this.deps.delegate) {
      try { result = await this.deps.delegate(step, goal, context, merged) } catch (error) { result = { ok: false, text: String((error as Error)?.message ?? error) } }
    } else result = { ok: false, text: 'free-form step and no delegate configured' }

    // Verification: an action that "succeeded" still has to pass its check.
    if (result.ok && step.check) {
      const check = await this.runAction(step.check, `verify: ${step.description}`, merged)
      this.world.observe(`step "${step.description}" achieved its effect`, { source: `check:${step.check.tool}`, supports: check.ok, reliability: 0.9 }, { verified: check.ok })
      if (!check.ok) result = { ok: false, text: `verification failed: ${check.text}` }
    }

    if (result.ok) {
      step.status = 'done'
      step.result = result.text.slice(0, 2000)
      step.lastError = undefined
    } else {
      step.lastError = result.text.slice(0, 2000)
      const retry = isTransient(result.text) && step.attempts < step.maxAttempts
      step.status = retry || result.text === 'needs approval' ? 'pending' : 'failed'
    }

    const capability = step.action?.tool ?? 'delegated work'
    await core.identity.recordOutcome(capability, result.ok).catch(() => undefined)
    await core.audit.record('agent', 'step', { goal: goal.id, step: step.id, ok: result.ok, attempt: step.attempts })
    await this.deps.memory?.retain([{
      kind: 'experience',
      content: `${result.ok ? 'Succeeded' : 'Failed'}: ${step.description}${result.ok ? '' : ` — ${step.lastError}`}`,
      context: `goal ${goal.title}`,
    }]).catch(() => undefined)
    await this.checkpoint()
    return { kind: 'worked', goalId: goal.id, stepId: step.id, ok: result.ok, detail: result.text.slice(0, 500) }
  }

  get isRunning(): boolean {
    return !!this.running
  }

  /**
   * Run ticks until stopped, idle for too long, or `maxTicks` reached. Idle
   * and waiting ticks back off to `idleMs`.
   */
  async run(options: { maxTicks?: number, intervalMs?: number, idleMs?: number, signal?: AbortSignal, onTick?: (r: TickReport) => void } = {}): Promise<TickReport[]> {
    if (this.running) throw new Error('executive: already running')
    this.running = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, this.running.signal]) : this.running.signal
    const reports: TickReport[] = []
    try {
      for (let i = 0; i < (options.maxTicks ?? Infinity) && !signal.aborted; i++) {
        const report = await this.tick(signal)
        reports.push(report)
        options.onTick?.(report)
        if (report.kind === 'stopped') break
        const wait = report.kind === 'idle' || report.kind === 'waiting' ? options.idleMs ?? 30_000 : options.intervalMs ?? 0
        if (wait > 0) await sleep(wait, signal)
      }
    } finally {
      this.running = undefined
    }
    return reports
  }

  stop(): void {
    this.running?.abort()
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}
