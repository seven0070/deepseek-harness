/**
 * Indicator probes. Each probe measures a functional property that some
 * scientific theory associates with consciousness, loosely following the
 * indicator-property approach of Butlin, Long et al. (2023), "Consciousness
 * in Artificial Intelligence: Insights from the Science of Consciousness".
 *
 * These numbers are behavioural and architectural indicators. They are NOT
 * evidence that the system is conscious, has experiences, or has moral
 * status, and nothing in this package claims so.
 *
 * @module dsh-subjectivity/probes
 */

export const DISCLAIMER = 'Research indicators only. These measurements describe functional properties that some theories '
  + 'associate with consciousness; they are not evidence that this system is conscious or has experiences.'

export interface Indicator {
  id: string
  theory: string
  property: string
  /** 0..1, or undefined when there is not enough data. */
  value?: number | undefined
  samples: number
  note: string
}

/** Metacognition (higher-order theories): does stated confidence track outcomes? */
export function calibration(pairs: readonly { confidence: number, correct: boolean }[], bins = 5): { brier: number, ece: number } | undefined {
  if (!pairs.length) return undefined
  const brier = pairs.reduce((s, p) => s + (p.confidence - (p.correct ? 1 : 0)) ** 2, 0) / pairs.length
  let ece = 0
  for (let b = 0; b < bins; b++) {
    const inBin = pairs.filter((p) => Math.min(bins - 1, Math.floor(p.confidence * bins)) === b)
    if (!inBin.length) continue
    const conf = inBin.reduce((s, p) => s + p.confidence, 0) / inBin.length
    const acc = inBin.filter((p) => p.correct).length / inBin.length
    ece += (inBin.length / pairs.length) * Math.abs(conf - acc)
  }
  return { brier, ece }
}

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])

export function jaccard(a: string, b: string): number {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size && !B.size) return 1
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** Mean pairwise similarity — self-model stability across paraphrases or time. */
export function consistency(answers: readonly string[]): number | undefined {
  if (answers.length < 2) return undefined
  let sum = 0
  let n = 0
  for (let i = 0; i < answers.length; i++) for (let j = i + 1; j < answers.length; j++) { sum += jaccard(answers[i]!, answers[j]!); n++ }
  return sum / n
}

/**
 * Global workspace: a limited-capacity focus whose content is broadcast and
 * then read by several specialised modules. We log each broadcast and which
 * modules consumed it, and measure how globally available focus content is.
 */
export class Workspace {
  private readonly broadcasts: { id: number, content: string, consumers: Set<string> }[] = []
  private readonly modules = new Set<string>()
  private next = 1

  constructor(private readonly capacity = 200) {}

  register(module: string): void {
    this.modules.add(module)
  }

  broadcast(content: string): number {
    const id = this.next++
    this.broadcasts.push({ id, content, consumers: new Set() })
    if (this.broadcasts.length > this.capacity) this.broadcasts.shift()
    return id
  }

  consume(id: number, module: string): void {
    this.modules.add(module)
    this.broadcasts.find((b) => b.id === id)?.consumers.add(module)
  }

  /** Mean share of registered modules that read each broadcast. */
  availability(): { value?: number | undefined, samples: number } {
    if (!this.broadcasts.length || !this.modules.size) return { samples: this.broadcasts.length }
    const value = this.broadcasts.reduce((s, b) => s + b.consumers.size / this.modules.size, 0) / this.broadcasts.length
    return { value, samples: this.broadcasts.length }
  }
}

/** Agency: share of actions that were chosen in pursuit of a self-held goal and whose outcome was then evaluated. */
export function agency(actions: readonly { goalId?: string | undefined, evaluated: boolean }[]): number | undefined {
  if (!actions.length) return undefined
  return actions.filter((a) => a.goalId && a.evaluated).length / actions.length
}
