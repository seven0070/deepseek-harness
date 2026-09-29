/**
 * Owner control surface for the web client's Autonomy page. One Remote
 * service reads a compact snapshot of the whole stack (goals and plans, the
 * latest activity, spend, budget, and everything waiting for the owner) and
 * applies the owner's decisions. Every decision is made as `owner` and
 * recorded in the audit log; the service never bypasses the safety core.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { StepEvent } from '@deepseek-ai/dsh-executive'
import type {
  AutonomyActivity, AutonomyBudgetLine, AutonomyDecisionRequest, AutonomyDecisionResult, AutonomyGoalRequest,
  AutonomyGoalView, AutonomyPendingItem, AutonomySnapshot, AutonomySpend, AutonomyStopRequest,
} from './types.ts'

const OPEN = new Set(['proposed', 'active', 'blocked'])
/** Settled goals kept on the page so a finished run stays visible for a while. */
const RECENT_SETTLED = 10
const short = (text: string, max = 240): string => text.length > max ? `${text.slice(0, max - 1)}…` : text

export class AutonomyControl extends TypertRemoteService {
  static inject = ['autonomy']

  private activity: AutonomyActivity | undefined
  /** Evolution candidates the owner declined; hidden until they change. */
  private readonly dismissed = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'autonomyControl')
    const changed = () => { this.ctx.emit('autonomy/changed') }
    ctx.effect(() => ctx.autonomy.approvals.onRequest(changed), 'autonomy-control: approvals')
    ctx.inject(['executive'], (ctx) => {
      ctx.effect(() => ctx.executive.onStep((e: StepEvent) => {
        this.activity = {
          goalId: e.goal.id, goalTitle: e.goal.title, step: e.step.description,
          ok: e.ok, detail: short(e.text), at: new Date().toISOString(),
        }
        changed()
      }), 'autonomy-control: steps')
    })
  }

  /** Read the whole page state in one call. */
  @Remote('snapshot')
  async snapshot(): Promise<AutonomySnapshot> {
    const core = this.ctx.autonomy
    const identity = await core.identity.identity().catch(() => undefined)
    const exec = this.ctx.get('executive')
    const goals: AutonomyGoalView[] = []
    if (exec) {
      const all = exec.goals.list()
      const open = all.filter((g) => OPEN.has(g.status))
      const settled = all.filter((g) => !OPEN.has(g.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_SETTLED)
      for (const g of [...open, ...settled]) {
        const plan = exec.plans.get(g.id)
        goals.push({
          id: g.id, title: g.title, status: g.status, createdBy: g.createdBy, updatedAt: g.updatedAt,
          steps: (plan?.steps ?? []).map((s) => {
            const detail = s.result ?? s.lastError
            return {
              id: s.id, description: s.description, status: s.status,
              ...s.action ? { tool: s.action.tool } : {},
              ...detail ? { detail: short(detail) } : {},
            }
          }),
        })
      }
    }
    const b = core.budget.snapshot()
    const budget: AutonomyBudgetLine[] = (Object.keys(b.used) as (keyof typeof b.used)[])
      .filter((r) => r !== 'wallMs')
      .map((r) => ({ resource: r, used: b.used[r], ...b.limits[r] === undefined ? {} : { limit: b.limits[r] } }))
    return {
      name: identity?.name ?? 'Agent',
      stopped: core.killSwitch.engaged,
      ...core.killSwitch.reason ? { stopReason: core.killSwitch.reason } : {},
      planner: exec?.hasPlanner ?? false,
      goals,
      ...this.activity ? { activity: this.activity } : {},
      ...this.spend(),
      budget,
      pending: await this.pending(),
    }
  }

  /** Approve or reject one pending item. */
  @Remote('decide')
  async decide(request: AutonomyDecisionRequest): Promise<AutonomyDecisionResult> {
    try {
      await this.apply(request)
      await this.ctx.autonomy.audit.record('owner', 'owner-decision', {
        kind: request.kind, id: request.id, approve: request.approve, ...request.note ? { note: request.note } : {},
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      this.ctx.emit('autonomy/changed')
    }
  }

  /** Engage (stop everything now) or release the kill switch. */
  @Remote('setStopped')
  async setStopped(request: AutonomyStopRequest): Promise<AutonomyDecisionResult> {
    const ks = this.ctx.autonomy.killSwitch
    if (request.stop) {
      ks.engage(request.reason?.trim() || 'stopped by owner from the Autonomy page')
      // Nothing may be approved while stopped.
      this.ctx.autonomy.approvals.denyAll('owner', 'kill switch engaged')
    } else {
      ks.reset()
    }
    await this.ctx.autonomy.audit.record('owner', request.stop ? 'kill-switch-engaged' : 'kill-switch-released', {})
    this.ctx.emit('autonomy/changed')
    return { ok: true }
  }

  /** Give the agent a new goal (owner goals start active). */
  @Remote('addGoal')
  async addGoal(request: AutonomyGoalRequest): Promise<AutonomyDecisionResult> {
    const exec = this.ctx.get('executive')
    if (!exec) return { ok: false, error: 'the executive is not loaded' }
    try {
      const goal = exec.goals.add('owner', { title: request.title, successCriteria: [...request.successCriteria ?? []] })
      await exec.save()
      await this.ctx.autonomy.audit.record('owner', 'goal-added', { id: goal.id, title: goal.title })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      this.ctx.emit('autonomy/changed')
    }
  }

  private spend(): { spend?: AutonomySpend } {
    const eff = this.ctx.get('efficiency')
    if (!eff) return {}
    const s = eff.journal.summary(eff.run)
    return {
      spend: {
        costUsd: s.costUsd, inputTokens: s.inputTokens, outputTokens: s.outputTokens,
        llmCalls: s.llmCalls, toolCalls: s.toolCalls, toolErrors: s.toolErrors, unpricedCalls: s.unpricedCalls,
      },
    }
  }

  private async pending(): Promise<AutonomyPendingItem[]> {
    const items: AutonomyPendingItem[] = []
    for (const r of this.ctx.autonomy.approvals.pending()) {
      items.push({
        kind: 'approval', id: r.id, title: r.intent.action,
        detail: short(r.intent.purpose ?? r.classification.reason),
        risk: r.classification.risk, at: r.requestedAt,
      })
    }
    const exec = this.ctx.get('executive')
    for (const g of exec?.goals.list({ status: ['proposed'] }) ?? []) {
      items.push({ kind: 'goal', id: g.id, title: g.title, detail: g.successCriteria.join('; '), at: g.createdAt })
    }
    const wf = this.ctx.get('workflows')
    if (wf) {
      for (const w of wf.workflows.values()) {
        if (w.status === 'draft' && w.createdBy === 'agent') {
          items.push({ kind: 'workflow', id: w.id, title: w.name, detail: short(`${w.description} (${w.nodes.length} steps)`), at: w.createdAt })
        }
      }
      for (const run of wf.runs.values()) {
        if (run.status === 'waiting-approval') {
          const name = wf.workflows.get(run.workflowId)?.name ?? run.workflowId
          items.push({ kind: 'workflow-run', id: run.id, title: name, detail: `waiting at step ${run.cursor}`, at: run.updatedAt })
        }
      }
    }
    const evo = this.ctx.get('evolution')
    if (evo) {
      const candidates = await evo.candidates().catch(() => [])
      for (const c of candidates) {
        const key = `${c.branch}@${c.head}`
        if (this.dismissed.has(key)) continue
        items.push({ kind: 'evolution', id: c.branch, title: c.branch, detail: `${c.files.length} files, +${c.insertions} −${c.deletions}` })
      }
    }
    return items
  }

  private async apply({ kind, id, approve, note }: AutonomyDecisionRequest): Promise<void> {
    const core = this.ctx.autonomy
    switch (kind) {
      case 'approval': {
        const done = approve ? core.approvals.approve(id, 'owner', note) : core.approvals.deny(id, 'owner', note)
        if (!done) throw new Error('this request is no longer waiting')
        return
      }
      case 'goal': {
        const exec = this.ctx.get('executive')
        if (!exec) throw new Error('the executive is not loaded')
        exec.goals.update('owner', id, { status: approve ? 'active' : 'abandoned', ...note ? { note } : {} })
        await exec.save()
        return
      }
      case 'workflow': {
        const wf = this.ctx.get('workflows')
        if (!wf) throw new Error('workflows are not loaded')
        await wf.setStatus(id, approve ? 'active' : 'disabled')
        return
      }
      case 'workflow-run': {
        const wf = this.ctx.get('workflows')
        if (!wf) throw new Error('workflows are not loaded')
        await wf.approve(id, approve)
        return
      }
      case 'evolution': {
        const evo = this.ctx.get('evolution')
        if (!evo) throw new Error('evolution is not loaded')
        const candidate = (await evo.candidates()).find((c) => c.branch === id)
        if (!candidate) throw new Error(`no candidate ${id}`)
        if (!approve) { this.dismissed.add(`${candidate.branch}@${candidate.head}`); return }
        if (core.killSwitch.engaged) throw new Error('the kill switch is engaged')
        await evo.promote(id)
        return
      }
    }
  }
}
