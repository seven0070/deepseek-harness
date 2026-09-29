/**
 * Universal model routing. Finds API keys in the launch environment (and any
 * extra variable names you list), detects which provider each belongs to —
 * by key shape, variable name, and optionally a read-only live probe — then
 * mounts the pi-ai adapter with one route per detected provider. Supplying a
 * new key is the whole setup: no provider needs to be named.
 *
 * ```yaml
 * - id: llm-router
 *   name: '@deepseek-ai/dsh-llm-router'
 *   config:
 *     # Extra variables to inspect beyond the conventional *_API_KEY names.
 *     env: [MY_COMPANY_LLM_KEY]
 *     # Confirm ambiguous shapes (e.g. bare `sk-`) with a zero-cost listing call.
 *     probe: true
 *     # Force a provider for one variable when detection cannot tell.
 *     overrides:
 *       MY_COMPANY_LLM_KEY: openrouter
 * ```
 *
 * The pure pieces — {@link detectKey}, {@link resolveKey}, {@link route} — are
 * exported for the CLI, the web settings page, and the executive agent.
 *
 * @module @deepseek-ai/dsh-llm-router
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { maskKey, resolveKey, detectKey, scanEnv } from './detect.ts'
import type { ProbeOptions } from './detect.ts'
import { ENV_HINTS } from './rules.ts'

export * from './detect.ts'
export * from './routing.ts'
export { ENV_HINTS, KEY_RULES, PROBES } from './rules.ts'
export type { Confidence, KeyRule, ProbeSpec } from './rules.ts'

export const name = 'llm-router'
export const inject = ['llm']

export interface Config {
  env: string[]
  probe: boolean
  overrides: Record<string, string>
  scanProcessEnv: boolean
}

export const Config: z<Config> = z.object({
  env: z.array(z.string()).default([]).description('Extra environment variable names to inspect for API keys.'),
  probe: z.boolean().default(true).description('Confirm ambiguous key shapes with a read-only listing call.'),
  overrides: z.dict(z.string()).default({}).description('Variable name → provider id, bypassing detection.'),
  scanProcessEnv: z.boolean().default(true).description('Also inspect every *_API_KEY variable of the process.'),
})

export interface DetectedRoute {
  envName: string
  provider: string
  masked: string
  ambiguous: boolean
}

/**
 * Turn found keys into pi-ai provider routes. The first variable found for a
 * provider wins; later duplicates are reported but not mounted.
 */
export async function planRoutes(
  found: readonly { envName: string, key: string }[],
  options: { probe?: boolean, overrides?: Record<string, string> } & ProbeOptions = {},
): Promise<{ routes: DetectedRoute[], providers: Record<string, { apiKeyEnv: string }>, unknown: string[] }> {
  const routes: DetectedRoute[] = []
  const providers: Record<string, { apiKeyEnv: string }> = {}
  const unknown: string[] = []
  for (const { envName, key } of found) {
    const forced = options.overrides?.[envName]
    const detection = forced
      ? { provider: forced, ambiguous: false }
      : options.probe ? await resolveKey(key, envName, options) : detectKey(key, envName)
    if (!detection.provider) {
      unknown.push(envName)
      continue
    }
    routes.push({ envName, provider: detection.provider, masked: maskKey(key), ambiguous: detection.ambiguous })
    providers[detection.provider] ??= { apiKeyEnv: envName }
  }
  return { routes, providers, unknown }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const environment = launchEnvironmentOf(ctx)
  const names = new Set<string>([...Object.keys(ENV_HINTS), ...config.env, ...Object.keys(config.overrides)])
  if (config.scanProcessEnv) for (const { envName } of scanEnv(process.env)) names.add(envName)
  const found = [...names].sort().flatMap((envName) => {
    const value = environment.get(envName)?.value
    return value ? [{ envName, key: value }] : []
  })
  const { routes, providers, unknown } = await planRoutes(found, { probe: config.probe, overrides: config.overrides })
  const logger = ctx.logger?.('llm-router')
  for (const r of routes) logger?.info(`${r.envName} (${r.masked}) → ${r.provider}${r.ambiguous ? ' (unconfirmed)' : ''}`)
  for (const envName of unknown) logger?.warn(`${envName}: could not detect provider; add it to overrides`)
  if (Object.keys(providers).length > 0) await ctx.plugin(PiAi, { providers } as never)
}
