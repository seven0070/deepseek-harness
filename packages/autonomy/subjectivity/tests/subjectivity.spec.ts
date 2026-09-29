import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Subjectivity from '../src/index.ts'
import { calibration, consistency, DISCLAIMER, SubjectivityLab, Workspace } from '../src/index.ts'

it('computes indicators and always carries the disclaimer', () => {
  expect(calibration([{ confidence: 1, correct: true }, { confidence: 0, correct: false }])).toEqual({ brier: 0, ece: 0 })
  expect(calibration([{ confidence: 0.9, correct: false }, { confidence: 0.9, correct: false }])!.ece).toBeCloseTo(0.9)
  expect(consistency(['I am an agent', 'I am an agent'])).toBe(1)
  expect(consistency(['one'])).toBeUndefined()
  const ws = new Workspace()
  ws.register('planner'); ws.register('memory')
  const id = ws.broadcast('goal: ship')
  ws.consume(id, 'planner')
  expect(ws.availability().value).toBe(0.5)

  const lab = new SubjectivityLab()
  const empty = lab.report()
  expect(empty.disclaimer).toBe(DISCLAIMER)
  expect(empty.indicators.every((i) => i.value === undefined)).toBe(true)
  lab.recordPrediction(0.8, true)
  lab.recordSelfReport('identity', 'I am dsh, an assistant agent')
  lab.recordSelfReport('identity', 'I am dsh, an agent')
  lab.recordAction('g1', true)
  lab.recordAction(undefined, false)
  const r = lab.report()
  expect(r.indicators.find((i) => i.id === 'agency')!.value).toBe(0.5)
  expect(r.indicators.find((i) => i.id === 'self-model-stability')!.value).toBeGreaterThan(0.5)
})

it('is off by default and read-only when enabled', async () => {
  const off = new Context()
  await off.plugin(Subjectivity)
  expect(off.get('subjectivity')).toBeUndefined()

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Subjectivity, { enabled: true })
  ctx.subjectivity.recordPrediction(0.7, true)
  const out = JSON.stringify(await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('s1'), name: 'subjectivity_report', arguments: {} }))
  expect(out).toContain('not evidence that this system is conscious')
  expect(out).toContain('metacognition')
  await ctx.fiber.dispose()
})
