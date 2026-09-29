/**
 * Goal hierarchy. Owner goals are authoritative; the agent may decompose them
 * into subgoals freely, but a new top-level goal proposed by the agent stays
 * `proposed` until the owner accepts it — the agent cannot grant itself new
 * missions.
 *
 * @module dsh-executive/goals
 */
import { randomUUID } from 'node:crypto'

export type GoalStatus = 'proposed' | 'active' | 'blocked' | 'done' | 'failed' | 'abandoned'
export type GoalOwner = 'owner' | 'agent'

export interface Goal {
  id: string
  title: string
  /** How to tell it is done; used by verification. */
  successCriteria: string[]
  parentId?: string | undefined
  status: GoalStatus
  /** Higher runs first. */
  priority: number
  createdBy: GoalOwner
  createdAt: string
  updatedAt: string
  deadline?: string | undefined
  notes: string[]
}

export interface GoalState {
  goals: Goal[]
}

const OPEN: readonly GoalStatus[] = ['proposed', 'active', 'blocked']

export class GoalTree {
  constructor(private state: GoalState = { goals: [] }, private readonly now: () => Date = () => new Date()) {}

  toJSON(): GoalState {
    return structuredClone(this.state)
  }

  get(id: string): Goal | undefined {
    return this.state.goals.find((g) => g.id === id)
  }

  list(filter: { status?: GoalStatus[], parentId?: string | null } = {}): Goal[] {
    return this.state.goals.filter((g) => (!filter.status || filter.status.includes(g.status))
      && (filter.parentId === undefined || (filter.parentId === null ? !g.parentId : g.parentId === filter.parentId)))
  }

  children(id: string): Goal[] {
    return this.state.goals.filter((g) => g.parentId === id)
  }

  add(by: GoalOwner, input: { title: string, successCriteria?: string[], parentId?: string, priority?: number, deadline?: string }): Goal {
    const title = input.title.trim()
    if (!title) throw new Error('goals: title is required')
    const parent = input.parentId ? this.get(input.parentId) : undefined
    if (input.parentId && !parent) throw new Error(`goals: no parent ${input.parentId}`)
    if (parent && !OPEN.includes(parent.status)) throw new Error(`goals: parent is ${parent.status}`)
    const at = this.now().toISOString()
    const goal: Goal = {
      id: randomUUID().slice(0, 8),
      title,
      successCriteria: input.successCriteria ?? [],
      parentId: parent?.id,
      // Subgoals inherit legitimacy from their parent; agent top-level goals need approval.
      status: by === 'agent' && !parent ? 'proposed' : (parent?.status === 'proposed' ? 'proposed' : 'active'),
      priority: input.priority ?? parent?.priority ?? 0,
      createdBy: by,
      createdAt: at,
      updatedAt: at,
      deadline: input.deadline,
      notes: [],
    }
    this.state.goals.push(goal)
    return goal
  }

  update(by: GoalOwner, id: string, patch: { status?: GoalStatus, priority?: number, note?: string }): Goal {
    const goal = this.get(id)
    if (!goal) throw new Error(`goals: no goal ${id}`)
    if (patch.status === 'active' && goal.status === 'proposed' && by !== 'owner') {
      throw new Error('goals: only the owner can accept a proposed goal')
    }
    if (by === 'agent' && goal.createdBy === 'owner' && patch.status === 'abandoned') {
      throw new Error('goals: only the owner can abandon an owner goal; mark it blocked with a note instead')
    }
    if (patch.status) goal.status = patch.status
    if (patch.priority !== undefined) goal.priority = patch.priority
    if (patch.note?.trim()) goal.notes = [...goal.notes, patch.note.trim()].slice(-50)
    goal.updatedAt = this.now().toISOString()
    // A parent completes when every child is done.
    if (goal.status === 'done' && goal.parentId) {
      const parent = this.get(goal.parentId)
      if (parent && parent.status === 'active' && this.children(parent.id).every((c) => c.status === 'done')) {
        parent.status = 'done'
        parent.updatedAt = goal.updatedAt
      }
    }
    return goal
  }

  /**
   * The goal to work on now: the highest-priority active leaf (a goal with no
   * open children), earliest deadline first on ties.
   */
  next(): Goal | undefined {
    const leaves = this.state.goals.filter((g) => g.status === 'active'
      && !this.children(g.id).some((c) => OPEN.includes(c.status)))
    return leaves.sort((a, b) => b.priority - a.priority
      || (a.deadline ?? '\uffff').localeCompare(b.deadline ?? '\uffff')
      || a.createdAt.localeCompare(b.createdAt))[0]
  }
}
