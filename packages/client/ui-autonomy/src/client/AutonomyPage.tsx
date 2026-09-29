/** First-level Autonomy page: kill switch, owner inbox, goals with plan progress, latest action, and spend. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconCloseOutlineRegular, IconPlayOutlineRegular, IconPlusOutlineRegular,
  IconStopFillRegular, Input, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  AutonomyActivity, AutonomyBudgetLine, AutonomyGoalStatus, AutonomyGoalView, AutonomyPendingItem, AutonomySnapshot,
  AutonomySpend, AutonomyStepStatus,
} from '@deepseek-ai/dsh-autonomy/types'
import type { AutonomyInjected } from './source.ts'
import { NS } from './locales.ts'
import css from './AutonomyPage.module.css'

/** Full props for the Autonomy main panel. */
export type AutonomyPageProps = PropsRuntime<'main'>
  & InjectFace<AutonomyInjected>
  & PropsLocale<typeof NS>

type T = TranslateNS<typeof NS>

/** How long an armed stop waits for its confirming press. */
const STOP_ARM_MS = 3_000

const GOAL_DOT: Record<AutonomyGoalStatus, StateDotState> = {
  proposed: 'warning', active: 'ongoing', blocked: 'warning', done: 'done', failed: 'error', abandoned: 'idle',
}
const STEP_DOT: Record<AutonomyStepStatus, StateDotState> = {
  pending: 'idle', running: 'ongoing', done: 'done', failed: 'error', skipped: 'idle',
}

/** Cents for ordinary amounts; four decimals only for sub-cent spend, where cents would read $0.00. */
const usd = (value: number): string => `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
const count = (value: number): string => new Intl.NumberFormat().format(Math.round(value))

/**
 * Render the whole autonomy stack for its owner.
 * @param props - framework view, localized copy, and owner actions.
 * @returns the Autonomy page.
 */
export function AutonomyPage(props: AutonomyPageProps) {
  const { useAutonomy, onRetry, t } = props
  const view = useAutonomy(v => v)
  const snapshot = view.snapshot
  return (
    <section className={css.page} aria-label={t('title')} data-testid="autonomy-page">
      <div className={css.pageScroll}>
        <div className={css.pageContent}>
          {snapshot === undefined
            ? (
                <>
                  <div className={css.pageHeading}><h1>{t('title')}</h1></div>
                  {view.status === 'error'
                    ? (
                        <div className={css.notice} role="alert">
                          <strong>{t('unreachable.title')}</strong>
                          <span>{t('unreachable.body')}</span>
                          <Button variant="outline" size="sm" onClick={onRetry}>{t('retry')}</Button>
                        </div>
                      )
                    : <p className={css.muted} role="status">{t('loading')}</p>}
                </>
              )
            : <Loaded {...props} snapshot={snapshot} />}
        </div>
      </div>
    </section>
  )
}

function Loaded({ snapshot, onDecide, onSetStopped, onAddGoal, t }: AutonomyPageProps & { snapshot: AutonomySnapshot }) {
  const [error, setError] = useState<string | undefined>()
  const report = (result: { ok: boolean, error?: string }): boolean => {
    setError(result.ok ? undefined : t('action.failed', { error: result.error ?? '' }))
    return result.ok
  }
  return (
    <>
      <div className={css.pageHeading}>
        <h1>{t('title')}</h1>
        <StopControl stopped={snapshot.stopped} onSetStopped={async stop => report(await onSetStopped(stop))} t={t} />
      </div>
      <div className={clsx(css.state, snapshot.stopped && css.stateStopped)} role="status">
        <StateDot state={snapshot.stopped ? 'error' : 'ongoing'} size={10} />
        <span>{t(snapshot.stopped ? 'state.stopped' : 'state.running', { name: snapshot.name })}</span>
        {snapshot.stopped && snapshot.stopReason !== undefined && <span className={css.muted}>{snapshot.stopReason}</span>}
      </div>
      {!snapshot.planner && <p className={css.hint}>{t('state.noPlanner')}</p>}
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}

      <h2 className={css.sectionTitle}>
        {t('section.pending')}
        {snapshot.pending.length > 0 && <span className={css.count}>{snapshot.pending.length}</span>}
      </h2>
      {snapshot.pending.length === 0
        ? <p className={css.muted}>{t('pending.empty')}</p>
        : (
            <ul className={css.list}>
              {snapshot.pending.map(item => (
                <PendingCard
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  disabled={snapshot.stopped && item.kind !== 'goal'}
                  onDecide={async approve => report(await onDecide({ kind: item.kind, id: item.id, approve }))}
                  t={t}
                />
              ))}
            </ul>
          )}

      <h2 className={css.sectionTitle}>{t('section.goals')}</h2>
      <GoalForm onAddGoal={async title => report(await onAddGoal(title))} t={t} />
      {snapshot.goals.length === 0
        ? <p className={css.muted}>{t('goals.empty')}</p>
        : <ul className={css.list}>{snapshot.goals.map(goal => <GoalCard key={goal.id} goal={goal} t={t} />)}</ul>}

      <h2 className={css.sectionTitle}>{t('section.activity')}</h2>
      <Activity activity={snapshot.activity} t={t} />

      <h2 className={css.sectionTitle}>{t('section.spend')}</h2>
      <Spend spend={snapshot.spend} budget={snapshot.budget} t={t} />
    </>
  )
}

/** Two-press stop (a mis-click must not halt the agent), one-press resume. */
function StopControl({ stopped, onSetStopped, t }: { stopped: boolean, onSetStopped: (stop: boolean) => Promise<boolean>, t: T }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(timer.current) }, [])
  useEffect(() => { setArmed(false) }, [stopped])
  const run = async (stop: boolean): Promise<void> => {
    setBusy(true)
    try { await onSetStopped(stop) } finally { setBusy(false); setArmed(false) }
  }
  if (stopped) {
    return (
      <Button variant="primary" size="sm" disabled={busy} icon={<IconPlayOutlineRegular size={13} />} onClick={() => { void run(false) }}>
        {t('resume.action')}
      </Button>
    )
  }
  return (
    <Button
      variant={armed ? 'primary' : 'outline'}
      size="sm"
      className={clsx(css.stop, armed && css.stopArmed)}
      disabled={busy}
      icon={<IconStopFillRegular size={13} />}
      onClick={() => {
        if (armed) { clearTimeout(timer.current); void run(true); return }
        setArmed(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => { setArmed(false) }, STOP_ARM_MS)
      }}
    >
      {t(armed ? 'stop.confirm' : 'stop.action')}
    </Button>
  )
}

function PendingCard({ item, disabled, onDecide, t }: {
  item: AutonomyPendingItem
  disabled: boolean
  onDecide: (approve: boolean) => Promise<boolean>
  t: T
}) {
  const [busy, setBusy] = useState(false)
  const kind = t(`pending.kind.${item.kind}`)
  const decide = async (approve: boolean): Promise<void> => {
    setBusy(true)
    try { await onDecide(approve) } finally { setBusy(false) }
  }
  return (
    <li className={css.card} aria-label={t('pending.aria', { kind, title: item.title })}>
      <div className={css.cardMain}>
        <div className={css.cardMeta}>
          <span className={css.kind}>{kind}</span>
          {item.risk !== undefined && <span className={clsx(css.risk, (item.risk === 'high' || item.risk === 'critical') && css.riskHigh)}>{t('pending.risk', { risk: item.risk })}</span>}
        </div>
        <div className={css.cardTitle}>{item.title}</div>
        {item.detail !== '' && <div className={css.cardDetail}>{item.detail}</div>}
      </div>
      <div className={css.cardActions}>
        <Button variant="primary" size="sm" disabled={busy || disabled} icon={<IconCheckOutlineRegular size={13} />} onClick={() => { void decide(true) }}>
          {t('pending.approve')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} icon={<IconCloseOutlineRegular size={13} />} onClick={() => { void decide(false) }}>
          {t('pending.reject')}
        </Button>
      </div>
    </li>
  )
}

function GoalForm({ onAddGoal, t }: { onAddGoal: (title: string) => Promise<boolean>, t: T }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = title.trim()
    if (!text || busy) return
    setBusy(true)
    try { if (await onAddGoal(text)) setTitle('') } finally { setBusy(false) }
  }
  return (
    <form className={css.goalForm} onSubmit={(event) => { void submit(event) }}>
      <Input
        className={clsx(css.goalInput)}
        aria-label={t('goals.add.label')}
        placeholder={t('goals.add.placeholder')}
        value={title}
        onChange={(event) => { setTitle(event.target.value) }}
      />
      <Button type="submit" variant="primary" size="sm" disabled={busy || title.trim() === ''} icon={<IconPlusOutlineRegular size={13} />}>
        {t('goals.add.action')}
      </Button>
    </form>
  )
}

function GoalCard({ goal, t }: { goal: AutonomyGoalView, t: T }) {
  const done = goal.steps.filter(s => s.status === 'done' || s.status === 'skipped').length
  return (
    <li className={css.card}>
      <div className={css.cardMain}>
        <div className={css.goalHead}>
          <StateDot state={GOAL_DOT[goal.status]} size={10} />
          <span className={css.cardTitle}>{goal.title}</span>
          <span className={css.kind}>{t(`goal.status.${goal.status}`)}</span>
          {goal.createdBy === 'agent' && <span className={css.muted}>{t('goals.by.agent')}</span>}
          <span className={css.progress}>
            {goal.steps.length === 0 ? t('goals.noPlan') : t('goals.progress', { done, total: goal.steps.length })}
          </span>
        </div>
        {goal.steps.length > 0 && (
          <ol className={css.steps}>
            {goal.steps.map(step => (
              <li key={step.id} className={css.step}>
                <StateDot state={STEP_DOT[step.status]} size={8} appearance="step" />
                <span className={css.stepText}>
                  {step.description}
                  {step.tool !== undefined && <code className={css.tool}>{step.tool}</code>}
                </span>
                <span className={css.stepStatus}>{t(`step.status.${step.status}`)}</span>
                {step.detail !== undefined && step.status !== 'pending' && <span className={css.stepDetail}>{step.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </li>
  )
}

function Activity({ activity, t }: { activity: AutonomyActivity | undefined, t: T }) {
  if (activity === undefined) return <p className={css.muted}>{t('activity.empty')}</p>
  return (
    <div className={css.card}>
      <div className={css.cardMain}>
        <div className={css.goalHead}>
          <StateDot state={activity.ok ? 'done' : 'error'} size={10} />
          <span className={css.cardTitle}>{activity.step}</span>
          <span className={css.kind}>{t(activity.ok ? 'activity.ok' : 'activity.failed')}</span>
        </div>
        <div className={css.cardDetail}>{activity.goalTitle}</div>
        {activity.detail !== '' && <div className={css.cardDetail}>{activity.detail}</div>}
      </div>
    </div>
  )
}

function Spend({ spend, budget, t }: { spend: AutonomySpend | undefined, budget: readonly AutonomyBudgetLine[], t: T }) {
  const resource = (line: AutonomyBudgetLine): string => {
    switch (line.resource) {
      case 'tokens': return t('budget.resource.tokens')
      case 'usd': return t('budget.resource.usd')
      case 'actions': return t('budget.resource.actions')
      default: return line.resource
    }
  }
  const amount = (line: AutonomyBudgetLine, value: number): string => line.resource === 'usd' ? usd(value) : count(value)
  return (
    <div className={css.spend}>
      {spend === undefined
        ? <p className={css.muted}>{t('spend.none')}</p>
        : (
            <dl className={css.facts}>
              <dt>{t('spend.cost')}</dt>
              <dd>{usd(spend.costUsd)}</dd>
              <dt>{t('spend.tokens')}</dt>
              <dd>{t('spend.tokensValue', { input: count(spend.inputTokens), output: count(spend.outputTokens) })}</dd>
              <dt>{t('spend.calls')}</dt>
              <dd>{t('spend.callsValue', { llm: spend.llmCalls, tools: spend.toolCalls })}</dd>
            </dl>
          )}
      {spend !== undefined && spend.unpricedCalls > 0 && <p className={css.hint}>{t('spend.unpriced', { count: spend.unpricedCalls })}</p>}
      {budget.length > 0 && (
        <>
          <h3 className={css.subTitle}>{t('budget.title')}</h3>
          <ul className={css.budget}>
            {budget.map(line => {
              const ratio = line.limit === undefined || line.limit === 0 ? 0 : Math.min(1, line.used / line.limit)
              return (
                <li key={line.resource} className={css.budgetLine}>
                  <span>{resource(line)}</span>
                  <span className={css.meter} aria-hidden="true">
                    <span className={clsx(css.meterFill, ratio >= 0.9 && css.meterHigh)} style={{ width: `${ratio * 100}%` }} />
                  </span>
                  <span className={css.budgetValue}>
                    {line.limit === undefined
                      ? t('budget.unlimited', { used: amount(line, line.used) })
                      : t('budget.value', { used: amount(line, line.used), limit: amount(line, line.limit) })}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
