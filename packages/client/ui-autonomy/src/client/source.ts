/** One observable snapshot of the Host's autonomy stack plus the owner's actions. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AutonomyDecisionRequest, AutonomyDecisionResult, AutonomyGoalRequest, AutonomySnapshot, AutonomyStopRequest,
} from '@deepseek-ai/dsh-autonomy/types'

/** What the page renders: the last good snapshot and the state of the latest read. */
export interface AutonomyView {
  readonly status: 'loading' | 'ready' | 'error'
  /** Last successful snapshot; kept while a refresh is in flight or after it failed. */
  readonly snapshot?: AutonomySnapshot
}

/** Remote calls and invalidation subscriptions supplied by the registration. */
export interface AutonomyDependencies {
  readonly snapshot: () => Promise<RemoteResult<AutonomySnapshot>>
  readonly decide: (request: AutonomyDecisionRequest) => Promise<RemoteResult<AutonomyDecisionResult>>
  readonly setStopped: (request: AutonomyStopRequest) => Promise<RemoteResult<AutonomyDecisionResult>>
  readonly addGoal: (request: AutonomyGoalRequest) => Promise<RemoteResult<AutonomyDecisionResult>>
  readonly subscribeChanged: (listener: () => void) => () => void
  readonly subscribeReset: (listener: () => void) => () => void
}

/** Registration face handed to the page. */
export interface AutonomyInjected {
  readonly hooks: { readonly autonomy: HostObservable<AutonomyView> }
  readonly onDecide: (request: AutonomyDecisionRequest) => Promise<AutonomyDecisionResult>
  readonly onSetStopped: (stop: boolean) => Promise<AutonomyDecisionResult>
  readonly onAddGoal: (title: string) => Promise<AutonomyDecisionResult>
  readonly onRetry: () => void
}

/** Transport or Host failure folded into the business result the page shows. */
const unwrap = async (call: Promise<RemoteResult<AutonomyDecisionResult>>): Promise<AutonomyDecisionResult> => {
  try {
    const result = await call
    return result.ok ? result.value : { ok: false, error: result.error.message }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Create the page source. Remote subscriptions follow the framework's
 * subscribers: the first subscriber starts listening and reads, the last one
 * leaving stops. Reads never overlap; a change during a read queues one more.
 * @param deps - Remote calls and invalidations.
 * @returns observable view and page callbacks.
 */
export function createAutonomySource(deps: AutonomyDependencies): AutonomyInjected {
  let view: AutonomyView = { status: 'loading' }
  const listeners = new Set<() => void>()
  let disposers: readonly (() => void)[] = []
  let reading = false
  let again = false
  let epoch = 0
  const publish = (next: AutonomyView): void => {
    view = next
    for (const listener of listeners) listener()
  }
  const refresh = async (): Promise<void> => {
    if (reading) { again = true; return }
    reading = true
    const current = epoch
    if (view.status !== 'loading') publish({ ...view, status: 'loading' })
    try {
      const result = await deps.snapshot().catch(() => undefined)
      if (current !== epoch) return
      publish(result?.ok ? { status: 'ready', snapshot: result.value } : { ...view, status: 'error' })
    } finally {
      reading = false
      if (again && current === epoch) { again = false; void refresh() }
    }
  }
  const invalidate = (): void => { void refresh() }
  const act = async (call: Promise<RemoteResult<AutonomyDecisionResult>>): Promise<AutonomyDecisionResult> => {
    const result = await unwrap(call)
    // The Host announces the change too; reading here keeps the page right
    // even when the event is lost across a reconnect.
    void refresh()
    return result
  }
  return {
    hooks: {
      autonomy: {
        getSnapshot: () => view,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            disposers = [deps.subscribeChanged(invalidate), deps.subscribeReset(invalidate)]
            invalidate()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            for (const dispose of disposers) dispose()
            disposers = []
            epoch++
            reading = false
            again = false
          }
        },
      },
    },
    onDecide: request => act(deps.decide(request)),
    onSetStopped: stop => act(deps.setStopped({ stop })),
    onAddGoal: title => act(deps.addGoal({ title })),
    onRetry: invalidate,
  }
}
