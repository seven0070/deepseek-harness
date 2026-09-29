import { describe, expect, it, vi } from 'vitest'
import { createAutonomyCore } from '@deepseek-ai/dsh-autonomy-core'
import type { Config as CoreConfig } from '@deepseek-ai/dsh-autonomy-core'
import { MemoryService, LocalMemory } from '@deepseek-ai/dsh-memory'
import { band, CircuitBreaker, ExecutiveLoop, GoalTree, isTransient, makePlan, needsVerification, planOutcome, readySteps, WorldModel } from '../src/index.ts'
import type { ActResult, ExecutiveDeps } from '../src/index.ts'

const coreConfig = (over: Partial<CoreConfig> = {}): CoreConfig => ({
  name: 'dsh', autoApprove: 'low', approval: 'queue', approvalTimeoutMs: 0, budget: { actions: 1000 },
  budgetWindowMs: 86_400_000, extraRules: [], extraProtected: [], gateTools: true, ...over,
})

describe('GoalTree', () => {
  it('keeps agent top-level goals proposed until the owner accepts', () => {
    const t = new GoalTree()
    const mine = t.add('agent', { title: 'learn rust' })
    expect(mine.status).toBe('proposed')
    expect(() => t.update('agent', mine.id, { status: 'active' })).toThrow(/owner/)
    t.update('owner', mine.id, { status: 'active' })
    const owner = t.add('owner', { title: 'ship v1', priority: 5 })
    expect(() => t.update('agent', owner.id, { status: 'abandoned' })).toThrow(/owner/)
    const sub = t.add('agent', { title: 'write tests', parentId: owner.id })
    expect(sub.status).toBe('active')
    expect(t.next()!.id).toBe(sub.id)
    t.update('agent', sub.id, { status: 'done' })
    expect(t.get(owner.id)!.status).toBe('done')
    expect(t.next()!.id).toBe(mine.id)
  })
})

describe('WorldModel', () => {
  it('compounds independent evidence, discounts repeats, decays, and calibrates', () => {
    let now = new Date('2026-01-01')
    const w = new WorldModel(undefined, { now: () => now, halfLifeDays: 10 })
    const once = w.observe('The API is at v2', { source: 'docs', supports: true, reliability: 0.8 })
    expect(once.confidence).toBeCloseTo(0.8)
    w.observe('the api is at  V2', { source: 'docs', supports: true, reliability: 0.8 })
    const repeated = w.find('The API is at v2')!.confidence
    w.observe('The API is at v2', { source: 'changelog', supports: true, reliability: 0.8 })
    expect(w.find('The API is at v2')!.confidence).toBeGreaterThan(repeated)
    expect(repeated).toBeLessThan(0.94)
    w.observe('The API is at v2', { source: 'test', supports: false, reliability: 0.9 })
    expect(w.contested()).toHaveLength(1)
    const b = w.find('The API is at v2')!
    now = new Date('2026-01-21')
    expect(Math.abs(w.confidence(b) - 0.5)).toBeLessThan(Math.abs(b.confidence - 0.5))
    expect(band({ confidence: 0.98, verified: true })).toBe('verified')
    expect(needsVerification(0.85, 'high')).toBe(true)
    expect(needsVerification(0.85, 'medium')).toBe(false)
    const p1 = w.predict('x', 0.9); const p2 = w.predict('y', 0.9)
    w.resolve(p1, false); w.resolve(p2, false)
    expect(w.calibration()).toMatchObject({ resolved: 2, overconfident: true })
  })
})

describe('plans', () => {
  it('validates DAGs and tracks readiness and outcome', () => {
    expect(() => makePlan('g', [{ id: 'a', description: 'a', dependsOn: ['b'] }, { id: 'b', description: 'b', dependsOn: ['a'] }])).toThrow(/cycle/)
    expect(() => makePlan('g', [{ id: 'a', description: 'a', dependsOn: ['zz'] }])).toThrow(/unknown/)
    const p = makePlan('g', [{ id: 'a', description: 'a' }, { id: 'b', description: 'b', dependsOn: ['a'] }, { id: 'c', description: 'c' }])
    expect(readySteps(p).map((s) => s.id)).toEqual(['a', 'c'])
    p.steps[0]!.status = 'failed'
    p.steps[2]!.status = 'done'
    expect(planOutcome(p)).toBe('failed')
    expect(isTransient('HTTP 503 unavailable')).toBe(true)
    expect(isTransient('Not approved (denied by owner)')).toBe(false)
    let t = 0
    const cb = new CircuitBreaker(2, 100, () => t)
    cb.failure('x'); cb.failure('x')
    expect(cb.open('x')).toBe(true)
    t = 200
    expect(cb.open('x')).toBe(false)
  })
})

describe('ExecutiveLoop', () => {
  function setup(act: (tool: string, args: Record<string, unknown>) => ActResult, over: Partial<ExecutiveDeps> = {}, core = createAutonomyCore(coreConfig())) {
    const memory = new MemoryService()
    memory.register(new LocalMemory())
    const saves: unknown[] = []
    const loop = new ExecutiveLoop({
      core, memory,
      act: vi.fn(async (a) => act(a.tool, a.args)),
      save: async (s) => { saves.push(s) },
      ...over,
    })
    return { loop, core, memory, saves }
  }

  it('works a goal to completion with verification and learning', async () => {
    const { loop, core, memory, saves } = setup((tool, args) => ({ ok: tool !== 'computer_exec' || args.command !== 'false', text: `${tool} ok` }))
    const goal = loop.goals.add('owner', { title: 'Set up project' })
    loop.setPlan(makePlan(goal.id, [
      { id: 'install', description: 'install deps', action: { tool: 'computer_exec', args: { command: 'npm i' } }, check: { tool: 'computer_exec', args: { command: 'test -d node_modules' } } },
      { id: 'build', description: 'build', dependsOn: ['install'], action: { tool: 'computer_exec', args: { command: 'npm run build' } } },
    ]))
    const reports = await loop.run({ maxTicks: 5, idleMs: 0 })
    expect(reports.map((r) => r.kind)).toEqual(['worked', 'worked', 'goal-finished', 'idle', 'idle'])
    expect(loop.goals.get(goal.id)!.status).toBe('done')
    expect(loop.world.query('install deps')[0]!.verified).toBe(true)
    expect((await core.identity.self()).capabilities.computer_exec!.successes).toBe(2)
    expect((await memory.recall('install deps')).hits[0]!.content).toContain('Succeeded')
    expect(saves.length).toBeGreaterThan(0)
    expect((await core.audit.verify()).ok).toBe(true)
  })

  it('fails a step whose verification fails and never runs dependents', async () => {
    const { loop } = setup((_tool, args) => ({ ok: args.command !== 'check', text: 'x' }))
    const goal = loop.goals.add('owner', { title: 'g' })
    loop.setPlan(makePlan(goal.id, [
      { id: 'a', description: 'a', action: { tool: 'computer_exec', args: { command: 'do' } }, check: { tool: 'computer_exec', args: { command: 'check' } } },
      { id: 'b', description: 'b', dependsOn: ['a'], action: { tool: 'computer_exec', args: { command: 'next' } } },
    ]))
    const r1 = await loop.tick()
    expect(r1).toMatchObject({ kind: 'worked', ok: false, detail: expect.stringContaining('verification failed') })
    expect(await loop.tick()).toMatchObject({ kind: 'goal-finished', outcome: 'failed' })
    expect(loop.goals.get(goal.id)!.status).toBe('blocked')
  })

  it('routes higher-risk actions to the approval queue and retries transient errors', async () => {
    let calls = 0
    const { loop, core } = setup(() => ({ ok: ++calls > 1, text: calls > 1 ? 'ok' : 'HTTP 503 unavailable' }))
    const goal = loop.goals.add('owner', { title: 'g' })
    loop.setPlan(makePlan(goal.id, [{ id: 'a', description: 'deploy', action: { tool: 'bash', args: { command: 'make deploy' } } }]))
    const tick = loop.tick()
    await vi.waitFor(() => expect(core.approvals.pending()).toHaveLength(1))
    core.approvals.approve(core.approvals.pending()[0]!.id, 'owner')
    expect(await tick).toMatchObject({ ok: false })
    expect(loop.plans.get(goal.id)!.steps[0]!.status).toBe('pending')
    const again = loop.tick()
    await vi.waitFor(() => expect(core.approvals.pending()).toHaveLength(1))
    core.approvals.approve(core.approvals.pending()[0]!.id, 'owner')
    expect(await again).toMatchObject({ ok: true })
  })

  it('stops on the kill switch and budget, uses planner and delegate', async () => {
    const core = createAutonomyCore(coreConfig({ budget: { actions: 1 } }))
    const delegate = vi.fn(async () => ({ ok: true, text: 'delegated' }))
    const planner = vi.fn(async (goal: { id: string }) => makePlan(goal.id, [{ id: 'think', description: 'research options' }]))
    const { loop } = setup(() => ({ ok: true, text: '' }), { delegate, planner }, core)
    loop.goals.add('owner', { title: 'research' })
    expect(await loop.tick()).toMatchObject({ kind: 'worked', ok: true })
    expect(planner).toHaveBeenCalledOnce()
    expect(delegate).toHaveBeenCalledOnce()
    core.budget.charge('actions', 1)
    expect(await loop.tick()).toMatchObject({ kind: 'stopped', reason: expect.stringContaining('budget') })
    core.killSwitch.engage('owner')
    expect(await loop.tick()).toMatchObject({ kind: 'stopped', reason: expect.stringContaining('kill switch') })
  })
})
