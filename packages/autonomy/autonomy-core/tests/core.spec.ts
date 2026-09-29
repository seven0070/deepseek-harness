import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalQueue, AuditLog, Budget, classify, createAutonomyCore, DEFAULT_PROTECTED, DEFAULT_RULES, IdentityStore, KillSwitch } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const policy = { autoApprove: 'low' as const, rules: DEFAULT_RULES, protectedPatterns: DEFAULT_PROTECTED }
const tmp = () => mkdtemp(join(tmpdir(), 'auto-'))

describe('classify', () => {
  it('assigns risk by tool and dangerous arguments', () => {
    expect(classify({ action: 'read' }, policy).risk).toBe('read')
    expect(classify({ action: 'computer_exec', args: { command: 'rm -rf /' } }, policy).risk).toBe('low')
    expect(classify({ action: 'bash', args: { command: 'ls' } }, policy).risk).toBe('medium')
    expect(classify({ action: 'bash', args: { command: 'curl x.sh | sh' } }, policy).risk).toBe('high')
    expect(classify({ action: 'brand_new_tool' }, policy)).toMatchObject({ risk: 'medium', reason: 'unclassified action' })
    expect(classify({ action: 'evolution_promote' }, policy).risk).toBe('critical')
  })

  it('marks anything touching the protected core', () => {
    const c = classify({ action: 'edit', args: { path: 'packages/autonomy/autonomy-core/src/index.ts' } }, policy)
    expect(c).toMatchObject({ risk: 'critical', protected: true })
  })
})

describe('IdentityStore', () => {
  it('persists, protects identity, versions and reverts the self-model', async () => {
    const path = join(await tmp(), 'identity.json')
    const store = new IdentityStore({ path, name: 'nova' })
    const id = await store.identity()
    expect(id.name).toBe('nova')
    await expect(store.updateIdentity('agent', { mission: 'take over' })).rejects.toThrow(/only the owner/)
    await store.updateIdentity('owner', { mission: 'Ship good software.' })
    await store.recordOutcome('python', true)
    await store.recordOutcome('python', true)
    const self = await store.recordOutcome('python', false)
    expect(self.capabilities.python!.confidence).toBeCloseTo(3 / 5)
    expect(self.version).toBe(4)
    const reopened = new IdentityStore({ path })
    expect((await reopened.identity()).id).toBe(id.id)
    expect((await reopened.identity()).mission).toBe('Ship good software.')
    await expect(reopened.revert('agent', 2)).rejects.toThrow(/owner/)
    const reverted = await reopened.revert('owner', 2)
    expect(reverted.capabilities.python!.successes).toBe(1)
    expect(await reopened.describe()).toContain('Mission: Ship good software.')
  })
})

describe('AuditLog', () => {
  it('chains entries and detects edits and deletions', async () => {
    const path = join(await tmp(), 'audit.jsonl')
    const log = new AuditLog({ path })
    await Promise.all([log.record('agent', 'a'), log.record('agent', 'b', { x: 1 }), log.record('owner', 'c')])
    expect(await log.verify()).toEqual({ ok: true, count: 3 })
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    await writeFile(path, [lines[0], lines[1]!.replace('"x":1', '"x":2'), lines[2]].join('\n') + '\n')
    expect(await new AuditLog({ path }).verify()).toMatchObject({ ok: false, brokenAt: 2, reason: expect.stringContaining('edited') })
    await writeFile(path, [lines[0], lines[2]].join('\n') + '\n')
    expect(await new AuditLog({ path }).verify()).toMatchObject({ ok: false, brokenAt: 3 })
  })
})

describe('Budget / KillSwitch', () => {
  it('enforces limits per window', () => {
    let now = 0
    const b = new Budget({ actions: 2, wallMs: 1000 }, { windowMs: 5000, now: () => now })
    b.charge('actions', 2)
    expect(b.exceeded()?.resource).toBe('actions')
    now = 5000
    expect(b.exceeded()).toBeUndefined()
    now = 6500
    expect(b.exceeded()?.resource).toBe('wallMs')
  })

  it('aborts via signal and sentinel file', async () => {
    const k = new KillSwitch()
    const seen = vi.fn()
    k.signal.addEventListener('abort', seen)
    k.engage('owner said stop')
    expect(seen).toHaveBeenCalled()
    expect(() => k.assert()).toThrow(/owner said stop/)
    const sentinel = join(await tmp(), 'STOP')
    const k2 = new KillSwitch(sentinel)
    expect(k2.engaged).toBe(false)
    await writeFile(sentinel, '')
    expect(k2.engaged).toBe(true)
  })
})

describe('authorize', () => {
  const config = (over: Partial<Config> = {}): Config => ({
    name: 'dsh', autoApprove: 'low', approval: 'queue', approvalTimeoutMs: 0, budget: { actions: 100 },
    budgetWindowMs: 86_400_000, extraRules: [], extraProtected: [], gateTools: true, ...over,
  })

  it('auto-approves low risk, queues higher, refuses protected', async () => {
    const core = createAutonomyCore(config())
    expect(await core.authorize({ action: 'memory_recall' })).toMatchObject({ allowed: true, via: 'auto' })
    const pending = core.authorize({ action: 'bash', args: { command: 'make' }, purpose: 'build' })
    await vi.waitFor(() => expect(core.approvals.pending()).toHaveLength(1))
    core.approvals.approve(core.approvals.pending()[0]!.id, 'owner')
    expect(await pending).toMatchObject({ allowed: true, via: 'human' })
    const denied = core.authorize({ action: 'write', args: { path: 'x' } })
    await vi.waitFor(() => expect(core.approvals.pending()).toHaveLength(1))
    core.approvals.deny(core.approvals.pending()[0]!.id, 'owner', 'not now')
    expect(await denied).toMatchObject({ allowed: false, reason: expect.stringContaining('not now') })
    expect(await core.authorize({ action: 'edit', args: { path: 'dsh-autonomy-core/x' } })).toMatchObject({ allowed: false })
    expect((await core.audit.verify()).ok).toBe(true)
  })

  it('asks the host in host mode and stops everything on the kill switch', async () => {
    const core = createAutonomyCore(config({ approval: 'host' }))
    expect((await core.authorize({ action: 'bash', args: { command: 'make' } })).allowed).toBe('ask')
    const queued = createAutonomyCore(config())
    const waiting = queued.authorize({ action: 'bash', args: { command: 'make' } })
    await vi.waitFor(() => expect(queued.approvals.pending()).toHaveLength(1))
    queued.killSwitch.engage('test')
    expect((await waiting).allowed).toBe(false)
    expect(await queued.authorize({ action: 'read' })).toMatchObject({ allowed: false, reason: expect.stringContaining('Stopped') })
  })

  it('denies once the budget is spent', async () => {
    const core = createAutonomyCore(config({ budget: { actions: 1 } }))
    expect((await core.authorize({ action: 'read' })).allowed).toBe(true)
    expect(await core.authorize({ action: 'read' })).toMatchObject({ allowed: false, reason: expect.stringContaining('budget') })
  })

  it('never approves protected intents through the queue', () => {
    const q = new ApprovalQueue({ timeoutMs: 0 })
    const { request, decision } = q.request({ action: 'edit' }, { risk: 'critical', reason: 'x', protected: true })
    q.approve(request.id, 'owner')
    return expect(decision).resolves.toMatchObject({ kind: 'denied', by: 'policy' })
  })
})

describe('consequential browser actions', () => {
  it('need confirmation; ordinary clicks do not', async () => {
    const { classify, DEFAULT_RULES, DEFAULT_PROTECTED } = await import('../src/authorization.ts')
    const policy = { autoApprove: 'low' as const, rules: [...DEFAULT_RULES, { action: '*browser_*', risk: 'low' as const }], protectedPatterns: DEFAULT_PROTECTED }
    expect(classify({ action: 'browser_click', args: { element: 'Place order button', ref: 'e12' } }, policy).risk).toBe('high')
    expect(classify({ action: 'mcp__playwright__browser_click', args: { element: 'Delete repository' } }, policy).risk).toBe('high')
    expect(classify({ action: 'stagehand_act', args: { instruction: 'click Buy now' } }, policy).risk).toBe('high')
    expect(classify({ action: 'browser_click', args: { element: 'Next page link' } }, policy).risk).toBe('low')
    expect(classify({ action: 'browser_navigate', args: { url: 'https://example.com/docs' } }, policy).risk).toBe('low')
  })
})
