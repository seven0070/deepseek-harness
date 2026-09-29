/**
 * Autonomy page plugin, browser half: one first-level page (a sidebar entry
 * plus a `main` panel) showing the Host's autonomy stack — the kill switch,
 * everything waiting for the owner's decision, goals with plan progress, the
 * latest action, and spend. All reads and decisions go through the Host's
 * `autonomyControl` Remote namespace; the page holds no business state.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AutonomyIcon } from './AutonomyIcon.tsx'
import { AutonomyPage } from './AutonomyPage.tsx'
import { createAutonomySource, type AutonomyInjected } from './source.ts'
import { en, NS, zh, type AutonomyKey } from './locales.ts'

const PANEL_ID = 'autonomy' as MainPanelId

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Autonomy page copy. */
    'autonomy': AutonomyKey
  }
}

export type { AutonomyInjected, AutonomyView } from './source.ts'
export type { AutonomyPageProps } from './AutonomyPage.tsx'

/** Required services: the slot registry, dictionaries, and the Host Remote. */
export const inject = ['slots', 'locale', 'remote', 'remote.autonomyControl']

/**
 * Client plugin body: register the dictionaries, the page, and its sidebar entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-autonomy: dictionaries')
  const t = ctx.locale.bind(NS)
  const source = createAutonomySource({
    snapshot: () => ctx.remote.autonomyControl.snapshot(),
    decide: request => ctx.remote.autonomyControl.decide(request),
    setStopped: request => ctx.remote.autonomyControl.setStopped(request),
    addGoal: request => ctx.remote.autonomyControl.addGoal(request),
    subscribeChanged: listener => ctx.remote.$on('autonomy/changed', listener),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: (): AutonomyInjected => source,
  }, AutonomyPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    // Right after the Tasks page (order 10): both are first-level pages about background work.
    order: 11,
    locale: NS,
    label: () => t('panel'),
  }, AutonomyIcon))
}
