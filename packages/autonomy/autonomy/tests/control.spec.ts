import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Autonomy from '../src/index.ts'

it('serves the Autonomy page: snapshot, owner decisions, kill switch', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Autonomy, { core: { name: 'Ada' }, learning: { enabled: false } })
  await new Promise((r) => setTimeout(r, 20))
  let changes = 0
  ctx.on('autonomy/changed', () => { changes++ })
  const control = ctx.get('autonomyControl') as Autonomy.AutonomyControl

  const proposed = ctx.executive.goals.add('agent', { title: 'Tidy the docs', successCriteria: ['no broken links'] })
  let snap = await control.snapshot()
  expect(snap.name).toBe('Ada')
  expect(snap.stopped).toBe(false)
  expect(snap.planner).toBe(false) // no model service in this test
  expect(snap.pending).toEqual([expect.objectContaining({ kind: 'goal', id: proposed.id, detail: 'no broken links' })])

  expect(await control.decide({ kind: 'goal', id: proposed.id, approve: true })).toEqual({ ok: true })
  snap = await control.snapshot()
  expect(snap.pending).toEqual([])
  expect(snap.goals[0]).toMatchObject({ id: proposed.id, status: 'active', createdBy: 'agent' })

  expect(await control.addGoal({ title: 'Ship v2' })).toEqual({ ok: true })
  expect((await control.snapshot()).goals.map((g) => g.title)).toContain('Ship v2')
  expect(await control.decide({ kind: 'approval', id: 'nope', approve: true })).toEqual({ ok: false, error: 'this request is no longer waiting' })

  await control.setStopped({ stop: true })
  snap = await control.snapshot()
  expect(snap.stopped).toBe(true)
  expect(snap.stopReason).toContain('Autonomy page')
  await control.setStopped({ stop: false })
  expect((await control.snapshot()).stopped).toBe(false)
  expect(changes).toBeGreaterThanOrEqual(4)

  const actions = (await ctx.autonomy.audit.tail(100)).map((e) => e.action)
  expect(actions).toEqual(expect.arrayContaining(['owner-decision', 'goal-added', 'kill-switch-engaged', 'kill-switch-released']))
  await ctx.fiber.dispose()
})
