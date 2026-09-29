/**
 * Tamper-evident audit log. Every entry carries the SHA-256 of the previous
 * one, so deleting or editing any past record breaks the chain and
 * {@link AuditLog.verify} reports where.
 *
 * @module dsh-autonomy-core/audit
 */
import { createHash } from 'node:crypto'
import { appendLine, readLines } from './store.ts'

export interface AuditEntry {
  seq: number
  at: string
  actor: string
  action: string
  detail?: unknown
  prev: string
  hash: string
}

const GENESIS = '0'.repeat(64)

function digest(entry: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify([entry.seq, entry.at, entry.actor, entry.action, entry.detail ?? null, entry.prev])).digest('hex')
}

export class AuditLog {
  private entries: AuditEntry[] = []
  private loaded: Promise<void> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: { path?: string | undefined, now?: () => Date, keepInMemory?: number } = {}) {}

  private load(): Promise<void> {
    this.loaded ??= readLines<AuditEntry>(this.options.path).then((rows) => { this.entries = rows })
    return this.loaded
  }

  record(actor: string, action: string, detail?: unknown): Promise<AuditEntry> {
    const task = async (): Promise<AuditEntry> => {
      await this.load()
      const last = this.entries[this.entries.length - 1]
      const base = {
        seq: (last?.seq ?? 0) + 1,
        at: (this.options.now?.() ?? new Date()).toISOString(),
        actor,
        action,
        ...detail === undefined ? {} : { detail },
        prev: last?.hash ?? GENESIS,
      }
      const entry: AuditEntry = { ...base, hash: digest(base) }
      this.entries.push(entry)
      const keep = this.options.keepInMemory ?? 5000
      if (this.entries.length > keep) this.entries = this.entries.slice(-keep)
      await appendLine(this.options.path, entry)
      return entry
    }
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  async tail(n = 50): Promise<AuditEntry[]> {
    await this.load()
    await this.queue
    return this.entries.slice(-n)
  }

  /** Re-read the full log from disk (or memory) and check every link. */
  async verify(): Promise<{ ok: true, count: number } | { ok: false, brokenAt: number, reason: string }> {
    await this.queue
    const rows = this.options.path ? await readLines<AuditEntry>(this.options.path) : this.entries
    let prev = rows[0]?.prev ?? GENESIS
    for (const row of rows) {
      const { hash, ...rest } = row
      if (row.prev !== prev) return { ok: false, brokenAt: row.seq, reason: 'chain link mismatch (entry removed or reordered)' }
      if (digest(rest) !== hash) return { ok: false, brokenAt: row.seq, reason: 'content hash mismatch (entry edited)' }
      prev = hash
    }
    return { ok: true, count: rows.length }
  }
}
