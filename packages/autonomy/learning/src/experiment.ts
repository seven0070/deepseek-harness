/**
 * Controlled experiments: compare variants over repeated trials and decide
 * with a stated confidence, instead of trusting a single run.
 *
 * @module dsh-learning/experiment
 */

export interface VariantStats {
  name: string
  n: number
  mean: number
  stdev: number
  failures: number
}

export interface ExperimentResult {
  hypothesis: string
  variants: VariantStats[]
  winner?: string | undefined
  /** Two-sided p-value of best vs runner-up (Welch's t, normal approximation). */
  pValue?: number | undefined
  conclusion: string
}

export function stats(name: string, values: readonly number[], failures = 0): VariantStats {
  const n = values.length
  const mean = n ? values.reduce((s, v) => s + v, 0) / n : 0
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0
  return { name, n, mean, stdev: Math.sqrt(variance), failures }
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

export function welchP(a: VariantStats, b: VariantStats): number {
  if (a.n < 2 || b.n < 2) return 1
  const se = Math.sqrt(a.stdev ** 2 / a.n + b.stdev ** 2 / b.n)
  if (se === 0) return a.mean === b.mean ? 1 : 0
  return 2 * (1 - phi(Math.abs(a.mean - b.mean) / se))
}

/**
 * Run `trials` of each variant (interleaved, so drift affects all equally)
 * and compare. `higherIsBetter` decides the direction of the metric.
 */
export async function runExperiment(options: {
  hypothesis: string
  variants: readonly string[]
  trials: number
  trial(variant: string, index: number, signal?: AbortSignal): Promise<number | undefined>
  higherIsBetter?: boolean
  alpha?: number
  signal?: AbortSignal
}): Promise<ExperimentResult> {
  const values = new Map(options.variants.map((v) => [v, [] as number[]]))
  const failures = new Map(options.variants.map((v) => [v, 0]))
  for (let i = 0; i < options.trials; i++) {
    for (const v of options.variants) {
      options.signal?.throwIfAborted()
      let value: number | undefined
      try { value = await options.trial(v, i, options.signal) } catch { value = undefined }
      if (value === undefined || !Number.isFinite(value)) failures.set(v, failures.get(v)! + 1)
      else values.get(v)!.push(value)
    }
  }
  const sign = options.higherIsBetter === false ? -1 : 1
  const variants = options.variants.map((v) => stats(v, values.get(v)!, failures.get(v)!))
    .sort((a, b) => sign * (b.mean - a.mean))
  const [best, second] = variants
  const alpha = options.alpha ?? 0.05
  if (!best || !second) return { hypothesis: options.hypothesis, variants, conclusion: 'need at least two variants' }
  const pValue = welchP(best, second)
  const significant = pValue < alpha && best.n >= 2
  return {
    hypothesis: options.hypothesis,
    variants,
    pValue,
    ...significant ? { winner: best.name } : {},
    conclusion: significant
      ? `${best.name} is better than ${second.name} (mean ${best.mean.toFixed(4)} vs ${second.mean.toFixed(4)}, p=${pValue.toFixed(4)}).`
      : `No significant difference between ${best.name} and ${second.name} (p=${pValue.toFixed(3)}); run more trials or treat as inconclusive.`,
  }
}

/** Pull the last number following `metric=` (or the last number at all) from command output. */
export function parseMetric(output: string, name = 'metric'): number | undefined {
  const tagged = [...output.matchAll(new RegExp(`${name}\\s*[=:]\\s*(-?\\d+(?:\\.\\d+)?(?:e-?\\d+)?)`, 'gi'))].pop()
  if (tagged) return Number(tagged[1])
  const any = [...output.matchAll(/-?\d+(?:\.\d+)?/g)].pop()
  return any ? Number(any[0]) : undefined
}
