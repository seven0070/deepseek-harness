import { describe, expect, it, vi } from 'vitest'
import type { AutonomySnapshot } from '@deepseek-ai/dsh-autonomy/types'
import { createAutonomySource, type AutonomyDependencies } from '../src/client/source.ts'

const snap = (name: string) => ({ name, stopped: false, planner: true, goals: [], budget: [], pending: [] }) as AutonomySnapshot
const flush = () => new Promise(r => setTimeout(r, 0))

function deps(over: Partial<AutonomyDependencies> = {}) {
  const changed = new Set<() => void>()
  let n = 0
  const d = {
    snapshot: vi.fn(async () => ({ ok: true as const, value: snap(`v${++n}`) })),
    decide: vi.fn(async () => ({ ok: true as const, value: { ok: true as const } })),
    setStopped: vi.fn(async () => ({ ok: true as const, value: { ok: true as const } })),
    addGoal: vi.fn(async () => ({ ok: true as const, value: { ok: true as const } })),
    subscribeChanged: vi.fn((l: () => void) => { changed.add(l); return () => { changed.delete(l) } }),
    subscribeReset: vi.fn(() => () => {}),
    ...over,
  }
  return { d: d as unknown as AutonomyDependencies & typeof d, fire: () => { for (const l of changed) l() }, changed }
}

describe('createAutonomySource', () => {
  it('reads on first subscribe, refreshes on change, and stops listening when unused', async () => {
    const { d, fire, changed } = deps()
    const source = createAutonomySource(d)
    const obs = source.hooks.autonomy
    expect(obs.getSnapshot().status).toBe('loading')
    const off = obs.subscribe(() => {})
    await flush()
    expect(obs.getSnapshot()).toEqual({ status: 'ready', snapshot: snap('v1') })
    fire()
    await flush()
    expect(obs.getSnapshot().snapshot?.name).toBe('v2')
    off()
    expect(changed.size).toBe(0)
  })

  it('keeps the last snapshot when a refresh fails', async () => {
    let fail = false
    const { d, fire } = deps({
      snapshot: vi.fn(async () => fail
        ? { ok: false as const, error: { message: 'down' } as never }
        : { ok: true as const, value: snap('ok') }),
    })
    const obs = createAutonomySource(d).hooks.autonomy
    obs.subscribe(() => {})
    await flush()
    fail = true
    fire()
    await flush()
    expect(obs.getSnapshot()).toEqual({ status: 'error', snapshot: snap('ok') })
  })

  it('folds Remote failures into the action result and refreshes after acting', async () => {
    const { d } = deps({ decide: vi.fn(async () => ({ ok: false as const, error: { message: 'boom' } as never })) })
    const source = createAutonomySource(d)
    source.hooks.autonomy.subscribe(() => {})
    await flush()
    expect(await source.onDecide({ kind: 'goal', id: 'g', approve: true })).toEqual({ ok: false, error: 'boom' })
    expect(await source.onSetStopped(true)).toEqual({ ok: true })
    expect(d.setStopped).toHaveBeenCalledWith({ stop: true })
    expect(await source.onAddGoal('x')).toEqual({ ok: true })
    expect(d.addGoal).toHaveBeenCalledWith({ title: 'x' })
    await flush()
    expect(d.snapshot.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('never overlaps reads: a change during a read queues exactly one more', async () => {
    let release: () => void = () => {}
    const { d, fire } = deps({
      snapshot: vi.fn(() => new Promise<{ ok: true, value: AutonomySnapshot }>((r) => { release = () => r({ ok: true, value: snap('x') }) })),
    })
    createAutonomySource(d).hooks.autonomy.subscribe(() => {})
    fire(); fire(); fire()
    expect(d.snapshot).toHaveBeenCalledTimes(1)
    release()
    await flush()
    expect(d.snapshot).toHaveBeenCalledTimes(2)
  })
})
