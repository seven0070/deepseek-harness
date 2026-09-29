/**
 * Browser-safe vocabulary of the autonomy control surface: the snapshot the
 * web client's Autonomy page renders and the decisions it sends back.
 *
 * @module @deepseek-ai/dsh-autonomy/types
 */

/** Lifecycle of one goal, mirrored from the executive. */
export type AutonomyGoalStatus = 'proposed' | 'active' | 'blocked' | 'done' | 'failed' | 'abandoned'

/** Lifecycle of one plan step, mirrored from the executive. */
export type AutonomyStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface AutonomyStepView {
  readonly id: string
  readonly description: string
  readonly status: AutonomyStepStatus
  /** Tool the step calls directly, when the plan named one. */
  readonly tool?: string
  /** Result or last error, shortened. */
  readonly detail?: string
}

export interface AutonomyGoalView {
  readonly id: string
  readonly title: string
  readonly status: AutonomyGoalStatus
  readonly createdBy: 'owner' | 'agent'
  readonly updatedAt: string
  readonly steps: readonly AutonomyStepView[]
}

/** The most recent step the agent executed. */
export interface AutonomyActivity {
  readonly goalId: string
  readonly goalTitle: string
  readonly step: string
  readonly ok: boolean
  readonly detail: string
  readonly at: string
}

export interface AutonomySpend {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly llmCalls: number
  readonly toolCalls: number
  readonly toolErrors: number
  /** Model calls whose model had no price entry (their cost is not counted). */
  readonly unpricedCalls: number
}

export interface AutonomyBudgetLine {
  readonly resource: string
  readonly used: number
  readonly limit?: number
}

/** What the owner is asked to decide. */
export type AutonomyPendingKind = 'approval' | 'goal' | 'workflow' | 'workflow-run' | 'evolution'

export interface AutonomyPendingItem {
  readonly kind: AutonomyPendingKind
  /** Id the decision refers to (approval id, goal id, workflow id, run id, or branch). */
  readonly id: string
  readonly title: string
  readonly detail: string
  /** Risk level for approvals. */
  readonly risk?: string
  readonly at?: string
}

export interface AutonomySnapshot {
  readonly name: string
  readonly stopped: boolean
  readonly stopReason?: string
  /** Whether a model is connected as planner (without one only explicit plans run). */
  readonly planner: boolean
  readonly goals: readonly AutonomyGoalView[]
  readonly activity?: AutonomyActivity
  readonly spend?: AutonomySpend
  readonly budget: readonly AutonomyBudgetLine[]
  readonly pending: readonly AutonomyPendingItem[]
}

export interface AutonomyDecisionRequest {
  readonly kind: AutonomyPendingKind
  readonly id: string
  readonly approve: boolean
  readonly note?: string
}

export type AutonomyDecisionResult =
  | { readonly ok: true }
  | { readonly ok: false, readonly error: string }

export interface AutonomyStopRequest {
  readonly stop: boolean
  readonly reason?: string
}

export interface AutonomyGoalRequest {
  readonly title: string
  readonly successCriteria?: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Autonomy state changed; clients refetch the snapshot.
     * @mode emit
     */
    'autonomy/changed'(): void
  }
}
