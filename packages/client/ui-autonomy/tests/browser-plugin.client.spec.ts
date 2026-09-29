/**
 * ui-autonomy plugin halves: dictionaries, the `main` page and sidebar entry
 * registered against the real SlotRegistry, the page source wired to the
 * `autonomyControl` Remote namespace, fiber teardown, and the inert node entry.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { AutonomySnapshot } from '@deepseek-ai/dsh-autonomy/types'
import { apply, inject } from '../src/client/index.ts'
import type { AutonomyInjected } from '../src/client/source.ts'
import { apply as applyNode } from '../src/index.ts'
import { en, zh } from '../src/client/locales.ts'

type On = (event: 'autonomy/changed', listener: () => void) => () => void

// A Service preserves the associated namespace lookup used by the real Gateway.
class RemoteStub extends Service {
  constructor(ctx: Context, readonly $on: On) {
    super(ctx, 'remote')
  }
}

const SNAPSHOT = { name: 'Ada', stopped: false, planner: true, goals: [], budget: [], pending: [] } as AutonomySnapshot

async function bench(control: object, $on: On) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  new RemoteStub(ctx, $on)
  await ctx.plugin({ apply(provider: Context) { provider.provide('remote.autonomyControl', control as never) } }).await()
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  return ctx
}

function face(entry: StoredEntry): AutonomyInjected {
  const value = entry.inject?.(undefined as never)
  if (value === undefined) throw new Error('slot entry injected no face')
  return value as AutonomyInjected
}

describe('ui-autonomy browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.autonomyControl'])
  })

  it('keeps the English dictionary key-identical to the Chinese source', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('registers the page and its sidebar entry, wires the Remote, and unregisters on dispose', async () => {
    const snapshot = vi.fn(async () => ({ ok: true as const, value: SNAPSHOT }))
    const decide = vi.fn(async () => ({ ok: true as const, value: { ok: true as const } }))
    let onChanged: (() => void) | undefined
    const ctx = await bench({ snapshot, decide, setStopped: vi.fn(), addGoal: vi.fn() }, (_event, listener) => {
      onChanged = listener
      return () => { onChanged = undefined }
    })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.slots.register({
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        'sidebar.panellist': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    const page = ctx.slots.entries('main')[0]!
    expect(page.options.key).toBe('autonomy')
    const entry = ctx.slots.entries('sidebar.panellist')[0]!
    expect(entry.options.id).toBe('autonomy')
    ctx.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Autonomy')
    ctx.locale.setLocale('zh')
    expect(resolveSlotLabel(entry.options.label)).toBe('自主')

    const injected = face(page)
    const stop = injected.hooks.autonomy.subscribe(() => {})
    await vi.waitFor(() => { expect(injected.hooks.autonomy.getSnapshot()).toEqual({ status: 'ready', snapshot: SNAPSHOT }) })
    expect(onChanged).toBeDefined()
    onChanged!()
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2) })
    expect(await injected.onDecide({ kind: 'goal', id: 'g1', approve: true })).toEqual({ ok: true })
    expect(decide).toHaveBeenCalledWith({ kind: 'goal', id: 'g1', approve: true })
    stop()
    expect(onChanged).toBeUndefined()

    await fiber.dispose()
    expect(ctx.slots.entries('main')).toEqual([])
    expect(ctx.slots.entries('sidebar.panellist')).toEqual([])
  })

  it('has an inert node half', () => {
    expect(applyNode()).toBeUndefined()
  })
})
