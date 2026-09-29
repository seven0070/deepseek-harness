/**
 * Validation-gated skill optimization, after Microsoft SkillOpt
 * (https://github.com/microsoft/SkillOpt): the skill document is the
 * trainable state of a frozen agent. Each step scores rollouts on a training
 * minibatch, asks an optimizer for bounded add / delete / replace edits, and
 * accepts a candidate only if it strictly improves the held-out validation
 * score. A textual learning rate caps how much text one step may change, and
 * a rejected-edit buffer stops the optimizer re-proposing edits that failed.
 *
 * The rollout and the optimizer are injected: in production the rollout runs
 * the agent (or a subagent) with the candidate skill, and the optimizer is an
 * LLM call. For full SkillOpt (benchmarks, Sleep mode, WebUI), use
 * {@link skillOptCommand} to run the upstream CLI on the agent's computer.
 *
 * @module dsh-learning/skillopt
 */

export interface SkillEdit {
  op: 'add' | 'delete' | 'replace'
  /** Exact existing text for delete / replace. */
  target?: string | undefined
  /** New text for add / replace. */
  text?: string | undefined
}

export interface Rollout {
  /** 0..1 task score. */
  score: number
  /** What happened — fed to the optimizer on failures. */
  trace: string
}

export interface OptimizeOptions<Task> {
  skill: string
  train: readonly Task[]
  validation: readonly Task[]
  rollout(skill: string, task: Task, signal?: AbortSignal): Promise<Rollout>
  /** Propose edits from failing rollouts; `rejected` lists edits already tried and refused. */
  propose(skill: string, failures: { task: Task, rollout: Rollout }[], rejected: readonly SkillEdit[], signal?: AbortSignal): Promise<SkillEdit[]>
  epochs?: number
  batchSize?: number
  /** Textual learning rate: max characters one step may add + remove. */
  maxCharsPerStep?: number
  /** Scores below this count as failures for reflection. */
  failBelow?: number
  signal?: AbortSignal
  onStep?: (step: OptimizeStep) => void
}

export interface OptimizeStep {
  epoch: number
  step: number
  trainScore: number
  candidateValScore?: number | undefined
  bestValScore: number
  accepted: boolean
  edits: SkillEdit[]
  reason: string
}

export interface OptimizeResult {
  bestSkill: string
  baselineValScore: number
  bestValScore: number
  history: OptimizeStep[]
  improved: boolean
}

/** Apply edits in order; edits whose target is missing are skipped. */
export function applyEdits(skill: string, edits: readonly SkillEdit[]): { skill: string, applied: SkillEdit[], changedChars: number } {
  let out = skill
  const applied: SkillEdit[] = []
  let changed = 0
  for (const edit of edits) {
    if (edit.op === 'add' && edit.text?.trim()) {
      out = `${out.replace(/\s*$/, '')}\n${edit.text.trim()}\n`
      changed += edit.text.trim().length
      applied.push(edit)
    } else if ((edit.op === 'delete' || edit.op === 'replace') && edit.target && out.includes(edit.target)) {
      const text = edit.op === 'replace' ? edit.text ?? '' : ''
      out = out.replace(edit.target, text)
      changed += edit.target.length + text.length
      applied.push(edit)
    }
  }
  return { skill: out, applied, changedChars: changed }
}

const key = (e: SkillEdit): string => JSON.stringify([e.op, e.target ?? '', e.text ?? ''])

async function score<Task>(skill: string, tasks: readonly Task[], rollout: OptimizeOptions<Task>['rollout'], signal?: AbortSignal): Promise<{ mean: number, runs: { task: Task, rollout: Rollout }[] }> {
  const runs: { task: Task, rollout: Rollout }[] = []
  for (const task of tasks) {
    signal?.throwIfAborted()
    runs.push({ task, rollout: await rollout(skill, task, signal) })
  }
  const mean = runs.length ? runs.reduce((s, r) => s + Math.max(0, Math.min(1, r.rollout.score)), 0) / runs.length : 0
  return { mean, runs }
}

export async function optimizeSkill<Task>(options: OptimizeOptions<Task>): Promise<OptimizeResult> {
  const epochs = options.epochs ?? 2
  const batchSize = Math.max(1, options.batchSize ?? 4)
  const maxChars = options.maxCharsPerStep ?? 800
  const failBelow = options.failBelow ?? 1
  const rejected: SkillEdit[] = []
  const rejectedKeys = new Set<string>()
  const history: OptimizeStep[] = []

  let best = options.skill
  const baseline = (await score(best, options.validation, options.rollout, options.signal)).mean
  let bestVal = baseline

  for (let epoch = 1; epoch <= epochs; epoch++) {
    for (let start = 0, stepNo = 1; start < options.train.length; start += batchSize, stepNo++) {
      options.signal?.throwIfAborted()
      const batch = options.train.slice(start, start + batchSize)
      const train = await score(best, batch, options.rollout, options.signal)
      const failures = train.runs.filter((r) => r.rollout.score < failBelow)
      const record = (s: Omit<OptimizeStep, 'epoch' | 'step' | 'trainScore' | 'bestValScore'>): void => {
        const step = { epoch, step: stepNo, trainScore: train.mean, bestValScore: bestVal, ...s }
        history.push(step)
        options.onStep?.(step)
      }
      if (!failures.length) { record({ accepted: false, edits: [], reason: 'no failures in batch' }); continue }

      const proposed = (await options.propose(best, failures, rejected, options.signal)).filter((e) => !rejectedKeys.has(key(e)))
      const { skill: candidate, applied, changedChars } = applyEdits(best, proposed)
      if (!applied.length) { record({ accepted: false, edits: [], reason: 'no applicable edits' }); continue }
      if (changedChars > maxChars) {
        for (const e of applied) { rejected.push(e); rejectedKeys.add(key(e)) }
        record({ accepted: false, edits: applied, reason: `step too large (${changedChars} > ${maxChars} chars)` })
        continue
      }
      const val = (await score(candidate, options.validation, options.rollout, options.signal)).mean
      if (val > bestVal) {
        best = candidate
        bestVal = val
        record({ accepted: true, edits: applied, candidateValScore: val, reason: 'validation improved' })
      } else {
        for (const e of applied) { rejected.push(e); rejectedKeys.add(key(e)) }
        record({ accepted: false, edits: applied, candidateValScore: val, reason: 'validation did not improve' })
      }
    }
  }
  return { bestSkill: best, baselineValScore: baseline, bestValScore: bestVal, history, improved: bestVal > baseline }
}

/**
 * argv for the upstream SkillOpt CLI (`skillopt-train`, installed by
 * `pip install skillopt`; verified against 0.2.0). Output locations live in
 * the SkillOpt config; override single keys with `cfgOptions` ("key=value").
 */
export function skillOptCommand(options: { config: string, backend?: string, cfgOptions?: string[], extra?: string[] }): string[] {
  return [
    'skillopt-train',
    '--config', options.config,
    ...options.backend ? ['--backend', options.backend] : [],
    ...options.cfgOptions?.length ? ['--cfg-options', ...options.cfgOptions] : [],
    ...options.extra ?? [],
  ]
}
