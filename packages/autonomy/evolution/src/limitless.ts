/**
 * Limitless evolution: generation after generation with no cap on the number
 * of generations and no restriction on what may be mutated — any file in the
 * repository, including the protected safety core, can be changed by a
 * mutation.
 *
 * "Limitless" applies to exploration, not to promotion. Mutations live only
 * on `helix/*` branches. Nothing reaches the working branch without owner
 * approval (`evolution_promote` is critical risk), and a candidate that
 * touches the protected core additionally needs an explicit acknowledgement.
 * The kill switch stops the driver between and during generations.
 *
 * @module dsh-evolution/limitless
 */
import type { Evolution, Review } from './promotion.ts'

export interface GenerationReport {
  generation: number
  exitCode: number | null
  candidates: number
  eligible: Review[]
  at: string
}

export interface DriverOptions {
  evolution: Evolution
  /** Run one Helix generation (evolve on the first, resume afterwards); resolves with the exit code. */
  runGeneration(generation: number, signal: AbortSignal): Promise<number | null>
  /** 0 = unlimited. */
  maxGenerations?: number | undefined
  /** Pause between generations. */
  cooldownMs?: number | undefined
  /** Stop when this aborts (wire the kill switch here). */
  killSignal?: AbortSignal | undefined
  /** Called after each generation — e.g. notify the owner of candidates awaiting approval. */
  onGeneration?: ((report: GenerationReport) => void | Promise<void>) | undefined
  now?: () => Date
}

export class LimitlessDriver {
  readonly reports: GenerationReport[] = []
  private controller?: AbortController | undefined
  private loop?: Promise<void> | undefined
  generation = 0

  constructor(private readonly options: DriverOptions) {}

  get running(): boolean {
    return !!this.controller
  }

  /** Candidates from the latest generation still awaiting an owner decision. */
  get awaitingApproval(): Review[] {
    const promoted = new Set(this.options.evolution.promotions.map((p) => p.branch))
    return (this.reports.at(-1)?.eligible ?? []).filter((r) => !promoted.has(r.candidate.branch))
  }

  start(): Promise<void> {
    if (this.loop) return this.loop
    const controller = new AbortController()
    this.controller = controller
    const kill = this.options.killSignal
    const onKill = () => controller.abort(kill?.reason)
    kill?.addEventListener('abort', onKill, { once: true })
    if (kill?.aborted) controller.abort(kill.reason)
    this.loop = this.run(controller.signal).finally(() => {
      kill?.removeEventListener('abort', onKill)
      this.controller = undefined
      this.loop = undefined
    })
    return this.loop
  }

  stop(): Promise<void> | undefined {
    this.controller?.abort(new Error('stopped'))
    return this.loop
  }

  private async run(signal: AbortSignal): Promise<void> {
    const max = this.options.maxGenerations ?? 0
    while (!signal.aborted && (max === 0 || this.generation < max)) {
      this.generation++
      let exitCode: number | null = null
      try {
        exitCode = await this.options.runGeneration(this.generation, signal)
      } catch {
        if (signal.aborted) break
      }
      if (signal.aborted) break
      const candidates = await this.options.evolution.candidates()
      const eligible: Review[] = []
      for (const c of candidates) {
        if (signal.aborted) break
        const review = await this.options.evolution.review(c.branch).catch(() => undefined)
        if (review?.eligible) eligible.push(review)
      }
      const report: GenerationReport = { generation: this.generation, exitCode, candidates: candidates.length, eligible, at: (this.options.now?.() ?? new Date()).toISOString() }
      this.reports.push(report)
      if (this.reports.length > 100) this.reports.shift()
      await this.options.onGeneration?.(report)
      const cooldown = this.options.cooldownMs ?? 0
      if (cooldown > 0 && !signal.aborted) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, cooldown)
          signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
        })
      }
    }
  }
}
