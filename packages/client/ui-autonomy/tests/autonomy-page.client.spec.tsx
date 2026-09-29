// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { AutonomySnapshot } from '@deepseek-ai/dsh-autonomy/types'
import { AutonomyPage, type AutonomyPageProps } from '../src/client/AutonomyPage.tsx'
import type { AutonomyView } from '../src/client/source.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = makeTranslate(en) as AutonomyPageProps['t']

const SNAPSHOT: AutonomySnapshot = {
  name: 'Ada',
  stopped: false,
  planner: true,
  goals: [{
    id: 'g1', title: 'Ship release notes', status: 'active', createdBy: 'owner', updatedAt: '2026-09-29T10:00:00Z',
    steps: [
      { id: 'write', description: 'Write the note', status: 'done', detail: 'note written' },
      { id: 'test', description: 'Run the tests', status: 'running', tool: 'run_tests' },
      { id: 'ship', description: 'Deploy', status: 'pending', tool: 'deploy' },
    ],
  }],
  activity: { goalId: 'g1', goalTitle: 'Ship release notes', step: 'Write the note', ok: true, detail: 'note written', at: '2026-09-29T10:00:00Z' },
  spend: { costUsd: 0.0042, inputTokens: 3000, outputTokens: 600, llmCalls: 3, toolCalls: 2, toolErrors: 0, unpricedCalls: 0 },
  budget: [{ resource: 'usd', used: 0.5, limit: 1 }, { resource: 'actions', used: 4 }],
  pending: [{ kind: 'approval', id: 'a1', title: 'deploy', detail: 'Deploy to production', risk: 'high' }],
}

function props(view: AutonomyView, over: Partial<AutonomyPageProps> = {}): AutonomyPageProps {
  function useAutonomy<T>(select: (value: AutonomyView) => T): T {
    return select(view)
  }
  return {
    useAutonomy, t,
    onDecide: vi.fn(async () => ({ ok: true as const })),
    onSetStopped: vi.fn(async () => ({ ok: true as const })),
    onAddGoal: vi.fn(async () => ({ ok: true as const })),
    onRetry: vi.fn(),
    ...over,
  } as unknown as AutonomyPageProps
}

describe('AutonomyPage', () => {
  it('shows loading, then an unreachable notice with retry', () => {
    const { rerender } = render(<AutonomyPage {...props({ status: 'loading' })} />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    const p = props({ status: 'error' })
    rerender(<AutonomyPage {...p} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Can’t reach the autonomy system')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(p.onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders state, pending items, goals with steps, activity and spend', () => {
    render(<AutonomyPage {...props({ status: 'ready', snapshot: SNAPSHOT })} />)
    expect(screen.getByText('Ada is running')).toBeDefined()
    const card = screen.getByRole('listitem', { name: 'Action approval: deploy' })
    expect(within(card).getByText('Risk: high')).toBeDefined()
    expect(within(card).getByText('Deploy to production')).toBeDefined()
    expect(screen.getByText('1 of 3 steps')).toBeDefined()
    expect(screen.getByText('run_tests')).toBeDefined()
    expect(screen.getAllByText('note written').length).toBeGreaterThan(0)
    expect(screen.getByText('$0.0042')).toBeDefined()
    expect(screen.getByText('3 model · 2 tool')).toBeDefined()
    expect(screen.getByText('$0.50 of $1.00')).toBeDefined()
    expect(screen.getByText('4 (no limit)')).toBeDefined()
    expect(screen.queryByText(/No model connected/)).toBeNull()
  })

  it('sends approve and reject decisions for the item', async () => {
    const p = props({ status: 'ready', snapshot: SNAPSHOT })
    render(<AutonomyPage {...p} />)
    const card = screen.getByRole('listitem', { name: 'Action approval: deploy' })
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Approve' })) })
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Reject' })) })
    expect(p.onDecide).toHaveBeenNthCalledWith(1, { kind: 'approval', id: 'a1', approve: true })
    expect(p.onDecide).toHaveBeenNthCalledWith(2, { kind: 'approval', id: 'a1', approve: false })
  })

  it('shows a failed decision as an alert', async () => {
    const p = props({ status: 'ready', snapshot: SNAPSHOT }, { onDecide: vi.fn(async () => ({ ok: false as const, error: 'gone' })) })
    render(<AutonomyPage {...p} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })) })
    expect(screen.getByRole('alert').textContent).toBe('That didn’t work: gone')
  })

  it('needs two presses to stop, and disarms after a pause', async () => {
    vi.useFakeTimers()
    const p = props({ status: 'ready', snapshot: SNAPSHOT })
    render(<AutonomyPage {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop everything' }))
    expect(p.onSetStopped).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(3_100) })
    expect(screen.getByRole('button', { name: 'Stop everything' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Stop everything' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Click again to stop' })) })
    expect(p.onSetStopped).toHaveBeenCalledWith(true)
  })

  it('offers resume when stopped and blocks approvals meanwhile', async () => {
    const p = props({ status: 'ready', snapshot: { ...SNAPSHOT, stopped: true, stopReason: 'manual' } })
    render(<AutonomyPage {...p} />)
    expect(screen.getByText('Ada is stopped')).toBeDefined()
    expect(screen.getByText('manual')).toBeDefined()
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resume' })) })
    expect(p.onSetStopped).toHaveBeenCalledWith(false)
  })

  it('adds a goal and clears the field on success', async () => {
    const p = props({ status: 'ready', snapshot: { ...SNAPSHOT, goals: [], pending: [], planner: false } })
    render(<AutonomyPage {...p} />)
    expect(screen.getByText('No goals yet.')).toBeDefined()
    expect(screen.getByText('Nothing needs your decision.')).toBeDefined()
    expect(screen.getByText(/No model connected/)).toBeDefined()
    const input = screen.getByRole('textbox', { name: 'New goal' }) as HTMLInputElement
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '  Tidy the docs ' } })
    await act(async () => { fireEvent.click(add) })
    expect(p.onAddGoal).toHaveBeenCalledWith('Tidy the docs')
    expect(input.value).toBe('')
  })
})
