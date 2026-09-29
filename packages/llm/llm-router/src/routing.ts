/**
 * Policy-based model selection. Given the models reachable through detected
 * keys, produce an ordered route: the primary pick followed by fallbacks.
 * Pure — callers supply model facts (the plugin reads them from pi-ai).
 *
 * @module dsh-llm-router/routing
 */

export type Policy = 'balanced' | 'quality' | 'cost' | 'speed'

export interface ModelFacts {
  provider: string
  id: string
  /** USD per million input / output tokens; 0 means unknown. */
  cost?: { input: number, output: number }
  contextWindow?: number
  reasoning?: boolean
  input?: readonly string[]
}

export interface RouteRequest {
  policy?: Policy
  /** Provider ids to try first, in order. */
  prefer?: readonly string[]
  /** Provider ids never to use. */
  exclude?: readonly string[]
  /** Minimum context window the task needs. */
  minContext?: number
  needsReasoning?: boolean
  needsImages?: boolean
  /** How many models to return (primary + fallbacks). */
  limit?: number
}

export interface RouteEntry extends ModelFacts {
  score: number
}

/** Rough cost per million tokens, assuming a 3:1 input:output mix. */
function blendedCost(model: ModelFacts): number | undefined {
  if (!model.cost || (model.cost.input === 0 && model.cost.output === 0)) return undefined
  return (model.cost.input * 3 + model.cost.output) / 4
}

function score(model: ModelFacts, policy: Policy): number {
  const cost = blendedCost(model)
  // Price is the only quality proxy available offline; normalized with log so
  // one outlier does not dominate. Unknown cost scores neutrally.
  const quality = cost === undefined ? 0.5 : Math.min(1, Math.log10(1 + cost) / 2)
  const cheap = cost === undefined ? 0.5 : 1 / (1 + cost)
  const context = Math.min(1, Math.log2(1 + (model.contextWindow ?? 0) / 8192) / 6)
  const reasoning = model.reasoning ? 1 : 0
  switch (policy) {
    case 'quality': return quality * 0.6 + reasoning * 0.25 + context * 0.15
    case 'cost': return cheap * 0.8 + context * 0.2
    case 'speed': return cheap * 0.5 + (1 - reasoning) * 0.4 + context * 0.1
    case 'balanced':
    default: return quality * 0.35 + cheap * 0.35 + reasoning * 0.15 + context * 0.15
  }
}

/**
 * Rank the eligible models for a request.
 * @returns best first; empty when nothing satisfies the constraints.
 */
export function route(models: readonly ModelFacts[], request: RouteRequest = {}): RouteEntry[] {
  const policy = request.policy ?? 'balanced'
  const prefer = request.prefer ?? []
  const exclude = new Set(request.exclude ?? [])
  const eligible = models.filter((m) => !exclude.has(m.provider)
    && (!request.minContext || (m.contextWindow ?? 0) >= request.minContext)
    && (!request.needsReasoning || m.reasoning)
    && (!request.needsImages || m.input?.includes('image')))
  const preferRank = (provider: string): number => {
    const index = prefer.indexOf(provider)
    return index === -1 ? prefer.length : index
  }
  return eligible
    .map((m) => ({ ...m, score: score(m, policy) }))
    .sort((a, b) => preferRank(a.provider) - preferRank(b.provider) || b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, request.limit ?? 5)
}
