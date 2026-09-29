/**
 * Promotion and rollback of evolved candidates. Helix leaves candidates on
 * `helix/*` branches; nothing reaches the working branch unless:
 *
 *  1. the candidate does not touch any protected path (the safety core,
 *     evaluation suite, audit log…) — checked from the actual diff;
 *  2. its evaluation passes the configured gate on a fresh run;
 *  3. the owner approves (`evolution_promote` is a critical-risk intent).
 *
 * Promotion is a merge commit, and every promotion records the previous HEAD
 * so {@link Evolution.rollback} can restore it.
 *
 * @module dsh-evolution/promotion
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type Git = (args: readonly string[]) => Promise<string>

export interface Candidate {
  branch: string
  head: string
  files: string[]
  insertions: number
  deletions: number
}

export interface Promotion {
  branch: string
  previousHead: string
  mergedHead: string
  score?: number | undefined
  protectedFiles: string[]
  at: string
}

export interface Review {
  candidate: Candidate
  violations: string[]
  score?: number | undefined
  eligible: boolean
  /** Touches the protected core; promotable only with explicit owner acknowledgement. */
  requiresOwnerAck: boolean
  reason: string
}

export class Evolution {
  readonly promotions: Promotion[] = []

  constructor(private readonly options: {
    git: Git
    protectedPatterns: readonly string[]
    /** Runs the evaluator in the candidate's tree; returns its score. */
    evaluate?: ((branch: string) => Promise<number | undefined>) | undefined
    minScore?: number | undefined
    /**
     * `refuse` (default): candidates touching the protected core are never
     * eligible. `owner-approval`: they are eligible, but promotion requires an
     * explicit acknowledgement on top of the critical-risk owner approval.
     */
    protectedCore?: 'refuse' | 'owner-approval' | undefined
    branchPrefix?: string | undefined
    now?: () => Date
    /** Persist promotion history so rollback survives restarts. */
    stateFile?: string | undefined
  }) {}

  async load(): Promise<void> {
    if (!this.options.stateFile) return
    try {
      const saved = JSON.parse(await readFile(this.options.stateFile, 'utf8')) as Promotion[]
      this.promotions.splice(0, this.promotions.length, ...saved)
    } catch {}
  }

  private async save(): Promise<void> {
    if (!this.options.stateFile) return
    await mkdir(dirname(this.options.stateFile), { recursive: true })
    await writeFile(this.options.stateFile, JSON.stringify(this.promotions, null, 2))
  }

  private get prefix(): string {
    return this.options.branchPrefix ?? 'helix/'
  }

  async candidates(): Promise<Candidate[]> {
    const git = this.options.git
    const refs = (await git(['for-each-ref', '--format=%(refname:short) %(objectname)', `refs/heads/${this.prefix}`])).split('\n').filter(Boolean)
    const out: Candidate[] = []
    for (const line of refs) {
      const [branch, head] = line.split(' ') as [string, string]
      const base = (await git(['merge-base', 'HEAD', branch])).trim()
      const numstat = (await git(['diff', '--numstat', base, branch])).split('\n').filter(Boolean)
      let insertions = 0
      let deletions = 0
      const files: string[] = []
      for (const row of numstat) {
        const [a, d, file] = row.split('\t')
        insertions += Number(a) || 0
        deletions += Number(d) || 0
        if (file) files.push(file)
      }
      out.push({ branch, head, files, insertions, deletions })
    }
    return out
  }

  /** Files in the candidate that fall under the protected core. */
  violations(candidate: Pick<Candidate, 'files'>): string[] {
    return candidate.files.filter((f) => this.options.protectedPatterns.some((p) => f.includes(p)))
  }

  /**
   * Check a candidate without changing anything. Caller must separately
   * obtain owner approval before calling {@link promote}.
   */
  async review(branch: string): Promise<Review> {
    const candidate = (await this.candidates()).find((c) => c.branch === branch)
    if (!candidate) throw new Error(`evolution: no candidate branch ${branch}`)
    const violations = this.violations(candidate)
    const ownerOnly = violations.length > 0
    if (ownerOnly && this.options.protectedCore !== 'owner-approval') {
      return { candidate, violations, eligible: false, requiresOwnerAck: false, reason: `touches the protected core: ${violations.join(', ')}` }
    }
    if (!candidate.files.length) return { candidate, violations, eligible: false, requiresOwnerAck: ownerOnly, reason: 'no changes' }
    const score = await this.options.evaluate?.(branch)
    const min = this.options.minScore ?? 0
    if (this.options.evaluate && (score === undefined || score <= min)) {
      return { candidate, violations, score, eligible: false, requiresOwnerAck: ownerOnly, reason: `evaluation score ${score ?? 'missing'} is not above ${min}` }
    }
    return {
      candidate, violations, score, eligible: true, requiresOwnerAck: ownerOnly,
      reason: ownerOnly ? `passes the evaluation gate; MODIFIES THE PROTECTED CORE (${violations.join(', ')}) — owner acknowledgement required` : 'passes protected-core check and evaluation gate',
    }
  }

  async promote(branch: string, options: { acknowledgeProtected?: boolean | undefined } = {}): Promise<Promotion> {
    const review = await this.review(branch)
    if (!review.eligible) throw new Error(`evolution: ${branch} is not eligible — ${review.reason}`)
    if (review.requiresOwnerAck && !options.acknowledgeProtected) {
      throw new Error(`evolution: ${branch} modifies the protected core (${review.violations.join(', ')}); promotion needs acknowledgeProtected with owner approval`)
    }
    const git = this.options.git
    if ((await git(['status', '--porcelain'])).trim()) throw new Error('evolution: working tree is not clean')
    const previousHead = (await git(['rev-parse', 'HEAD'])).trim()
    await git(['merge', '--no-ff', '-m', `evolution: promote ${branch}${review.score !== undefined ? ` (score ${review.score})` : ''}`, branch])
    const mergedHead = (await git(['rev-parse', 'HEAD'])).trim()
    const p: Promotion = { branch, previousHead, mergedHead, score: review.score, protectedFiles: review.violations, at: (this.options.now?.() ?? new Date()).toISOString() }
    this.promotions.push(p)
    await this.save()
    return p
  }

  /** Undo the most recent promotion with a revert commit (history is kept). */
  async rollback(): Promise<Promotion> {
    const last = this.promotions.at(-1)
    if (!last) throw new Error('evolution: nothing to roll back')
    await this.options.git(['revert', '--no-edit', '-m', '1', last.mergedHead])
    this.promotions.pop()
    await this.save()
    return last
  }
}
