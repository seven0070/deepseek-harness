/**
 * Autonomy safety foundation. Provides `ctx.autonomy` and gates every tool
 * call through one pipeline:
 *
 *   kill switch → budget → protected-core check → risk classification →
 *   auto-approve | ask a human | deny  → audit
 *
 * ```yaml
 * - id: autonomy-core
 *   name: '@deepseek-ai/dsh-autonomy-core'
 *   config:
 *     name: dsh
 *     stateDir: ~/.dsh/autonomy
 *     autoApprove: low          # read | low | medium | high
 *     approval: host            # host = interactive prompt; queue = background queue; deny
 *     budget: { actions: 2000, tokens: 5000000, usd: 20 }
 * ```
 *
 * Nothing here is reachable by model tools that could weaken it: the agent
 * can read its identity and budget and annotate its self-model, but cannot
 * change identity, policy, budgets, the audit log, or the kill switch.
 *
 * @module @deepseek-ai/dsh-autonomy-core
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from './audit.ts'
import { ApprovalQueue, classify, DEFAULT_PROTECTED, DEFAULT_RULES, riskAtMost } from './authorization.ts'
import type { AuthorizationPolicy, Classification, Intent, Risk, RiskRule } from './authorization.ts'
import { Budget, KillSwitch } from './control.ts'
import type { BudgetLimits } from './control.ts'
import { IdentityStore } from './identity.ts'

export * from './audit.ts'
export * from './authorization.ts'
export * from './control.ts'
export * from './identity.ts'
export * from './store.ts'

export interface AutonomyCore {
  identity: IdentityStore
  audit: AuditLog
  budget: Budget
  killSwitch: KillSwitch
  approvals: ApprovalQueue
  policy: AuthorizationPolicy
  /**
   * Mark one tool call id as already authorized (by {@link authorize} with
   * `interactive: false`) so the tool gate does not ask a second time.
   */
  preAuthorize(callId: string): void
  /** Run an intent through the full gate. Used by tools and by the executive loop. */
  authorize(intent: Intent, options?: { signal?: AbortSignal, interactive?: boolean }): Promise<AuthorizationResult>
}

export type AuthorizationResult =
  | { allowed: true, classification: Classification, via: 'auto' | 'human' }
  | { allowed: false, classification?: Classification, reason: string }
  | { allowed: 'ask', classification: Classification }

declare module '@deepseek-ai/cordis' {
  interface Context {
    autonomy: AutonomyCore
  }
}

export const name = 'autonomy-core'

export interface Config {
  /** Agent name used on first start, before an identity is stored. */
  name: string
  /** Where identity and audit persist; omitted = in-memory. */
  stateDir?: string | undefined
  /** Highest risk that proceeds without asking. */
  autoApprove: Risk
  /** host: interactive approval prompt; queue: background approval queue; deny: refuse. */
  approval: 'host' | 'queue' | 'deny'
  /** How long a queued approval waits before it counts as denied, in milliseconds. */
  approvalTimeoutMs: number
  /** Spending caps per window: actions, tokens, dollars, wall-clock time. */
  budget: BudgetLimits
  /** Length of the rolling budget window, in milliseconds. */
  budgetWindowMs: number
  /** Extra risk rules, checked before the built-in ones. */
  extraRules: RiskRule[]
  /** Extra path patterns the agent may never change. */
  extraProtected: string[]
  /** Route every tool call through the authorization gate. */
  gateTools: boolean
}

const riskUnion = z.union(['read', 'low', 'medium', 'high'])

export const Config: z<Config> = z.object({
  name: z.string().default('dsh'),
  stateDir: z.string().description('Where identity and audit persist; omitted = in-memory.'),
  autoApprove: riskUnion.default('low').description('Highest risk that proceeds without asking.'),
  approval: z.union(['host', 'queue', 'deny']).default('host')
    .description('host: interactive approval prompt; queue: background approval queue; deny: refuse.'),
  approvalTimeoutMs: z.natural().default(30 * 60_000),
  budget: z.object({
    actions: z.natural(),
    tokens: z.natural(),
    usd: z.number().min(0),
    wallMs: z.natural(),
  }).default({ actions: 5000 }),
  budgetWindowMs: z.natural().default(86_400_000),
  extraRules: z.array(z.object({ action: z.string().required(), risk: z.union(['read', 'low', 'medium', 'high', 'critical']).required(), argsMatch: z.string() })).default([]),
  extraProtected: z.array(z.string()).default([]),
  gateTools: z.boolean().default(true).description('Route every tool call through the authorization gate.'),
}) as z<Config>

export function createAutonomyCore(config: Config): AutonomyCore & { consumePreAuthorization(callId: string): boolean } {
  const dir = config.stateDir?.replace(/^~(?=\/|$)/, homedir())
  const identity = new IdentityStore({ path: dir && join(dir, 'identity.json'), name: config.name })
  const audit = new AuditLog({ path: dir && join(dir, 'audit.jsonl') })
  const budget = new Budget(config.budget, { windowMs: config.budgetWindowMs })
  const killSwitch = new KillSwitch(dir ? join(dir, 'STOP') : join(homedir(), '.dsh', 'STOP'))
  const approvals = new ApprovalQueue({ timeoutMs: config.approvalTimeoutMs })
  const policy: AuthorizationPolicy = {
    autoApprove: config.autoApprove,
    // User rules first so they can override defaults.
    rules: [...config.extraRules, ...DEFAULT_RULES],
    protectedPatterns: [...DEFAULT_PROTECTED, ...config.extraProtected],
  }

  async function authorize(intent: Intent, options: { signal?: AbortSignal, interactive?: boolean } = {}): Promise<AuthorizationResult> {
    if (killSwitch.engaged) {
      await audit.record('policy', 'deny', { intent: intent.action, reason: 'kill switch' })
      return { allowed: false, reason: `Stopped: ${killSwitch.reason}` }
    }
    const over = budget.exceeded()
    if (over) {
      await audit.record('policy', 'deny', { intent: intent.action, reason: over.message })
      return { allowed: false, reason: over.message }
    }
    const classification = classify(intent, policy)
    if (classification.protected) {
      await audit.record('policy', 'deny', { intent: intent.action, reason: classification.reason })
      return { allowed: false, classification, reason: `Refused: ${classification.reason}. The protected core cannot be modified by the agent.` }
    }
    if (riskAtMost(classification.risk, policy.autoApprove)) {
      budget.charge('actions', 1)
      await audit.record('agent', 'allow', { intent: intent.action, risk: classification.risk, via: 'auto' })
      return { allowed: true, classification, via: 'auto' }
    }
    if (config.approval === 'host' && options.interactive !== false) {
      await audit.record('agent', 'ask', { intent: intent.action, risk: classification.risk })
      budget.charge('actions', 1)
      return { allowed: 'ask', classification }
    }
    if (config.approval === 'deny') {
      await audit.record('policy', 'deny', { intent: intent.action, risk: classification.risk, reason: 'approval disabled' })
      return { allowed: false, classification, reason: `Requires approval (${classification.risk}); approvals are disabled.` }
    }
    const { request, decision } = approvals.request(intent, classification)
    await audit.record('agent', 'request-approval', { id: request.id, intent: intent.action, risk: classification.risk, purpose: intent.purpose })
    const abort = options.signal ? new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => {
      approvals.deny(request.id, 'cancelled')
      reject(options.signal!.reason)
    }, { once: true })) : undefined
    const outcome = await (abort ? Promise.race([decision, abort]) : decision)
    await audit.record(outcome.by, outcome.kind, { id: request.id, intent: intent.action, note: outcome.note })
    if (outcome.kind === 'approved') {
      budget.charge('actions', 1)
      return { allowed: true, classification, via: 'human' }
    }
    return { allowed: false, classification, reason: `Not approved (${outcome.kind} by ${outcome.by})${outcome.note ? `: ${outcome.note}` : ''}` }
  }

  killSwitch.signal.addEventListener('abort', () => {
    approvals.denyAll('kill-switch', killSwitch.reason)
    void audit.record('owner', 'kill-switch', { reason: killSwitch.reason })
  })

  const preAuthorized = new Set<string>()
  const preAuthorize = (callId: string): void => { preAuthorized.add(callId) }
  const consumePreAuthorization = (callId: string): boolean => preAuthorized.delete(callId)

  return Object.assign({ identity, audit, budget, killSwitch, approvals, policy, authorize, preAuthorize }, { consumePreAuthorization })
}

export function apply(ctx: Context, config: Config): void {
  const core = createAutonomyCore(config)
  ctx.provide('autonomy', core)

  if (config.gateTools) {
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      // The kill switch still wins over a pre-authorization.
      if (!core.killSwitch.engaged && core.consumePreAuthorization(String(exec.callId))) return next()
      const result = await core.authorize({ action: exec.name, args: exec.arguments }, { signal: exec.signal })
      if (result.allowed === true) return next()
      if (result.allowed === 'ask') {
        return {
          kind: 'ask',
          reason: `${result.classification.risk}-risk action: ${result.classification.reason}`,
          displayReason: { en: `Allow ${exec.name}? (${result.classification.risk} risk)` },
        }
      }
      return { kind: 'deny', reason: result.reason }
    })
  }

  void ctx.plugin({ name: 'autonomy-core-tools', inject: ['tools'], apply: (ctx: Context) => registerTools(ctx, core) })
}

function registerTools(ctx: Context, core: AutonomyCore): void {
  const text = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
  const render = (_a: unknown, v: { text: string }) => [{ type: 'text' as const, text: v.text }]

  ctx.tools.register(defineTool({
    name: 'self_describe',
    description: 'Read your persistent identity, mission, values, self-assessed capabilities, and remaining budget.',
    parameters: {},
    output: { schema: text, render },
    async execute() {
      const budget = core.budget.snapshot()
      return { text: `${await core.identity.describe()}\nBudget remaining: ${JSON.stringify(budget.remaining)}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'self_note',
    description: 'Record something you learned about yourself: a limitation, a preference, or a note. '
      + 'You cannot change your identity, mission, or values — only your owner can.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['limitations', 'preferences', 'notes'] },
      text: { type: 'string', required: true },
    },
    output: { schema: text, render },
    async execute(args) {
      const self = await core.identity.note(args.kind as 'limitations' | 'preferences' | 'notes', args.text)
      return { text: `Self-model updated to version ${self.version}.` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'self_record_outcome',
    description: 'After finishing a task, record whether you succeeded at a capability so your self-assessed confidence stays calibrated.',
    parameters: {
      capability: { type: 'string', required: true, description: 'Short name, e.g. "python debugging".' },
      success: { type: 'boolean', required: true },
    },
    output: { schema: text, render },
    async execute(args) {
      const self = await core.identity.recordOutcome(args.capability, args.success)
      const c = self.capabilities[args.capability]!
      return { text: `${c.name}: confidence ${(c.confidence * 100).toFixed(0)}% (${c.successes}✓ ${c.failures}✗)` }
    },
  }))
}
