/**
 * Durable workflow graphs (idea from OpenHuman workflows / tinyflows,
 * re-implemented). A workflow is a typed graph of nodes; a run walks it,
 * persists its state after every node, and can pause (approval, delay) and
 * resume later — including after a restart.
 *
 * Node kinds:
 *  - `tool`      call a tool; args may use `{{node.output}}` / `{{input.x}}` templates
 *  - `agent`     hand a prompt to an agent (injected delegate)
 *  - `condition` branch on the previous output (contains / regex / equals)
 *  - `approval`  pause until the owner approves
 *  - `delay`     pause for a duration
 *
 * @module dsh-workflows/engine
 */
import { randomUUID } from 'node:crypto'

export type WorkflowNode =
  | { id: string, kind: 'tool', tool: string, args?: Record<string, unknown>, next?: string }
  | { id: string, kind: 'agent', prompt: string, next?: string }
  | { id: string, kind: 'condition', input?: string, test: { contains?: string, regex?: string, equals?: string }, then: string, else?: string }
  | { id: string, kind: 'approval', message: string, next?: string }
  | { id: string, kind: 'delay', ms: number, next?: string }

export interface WorkflowTrigger {
  kind: 'manual' | 'schedule'
  /** schedule: run every N ms. */
  everyMs?: number
}

export interface Workflow {
  id: string
  name: string
  description: string
  start: string
  nodes: WorkflowNode[]
  trigger: WorkflowTrigger
  status: 'draft' | 'active' | 'disabled'
  createdBy: 'agent' | 'owner'
  createdAt: string
}

export type RunStatus = 'running' | 'waiting-approval' | 'waiting-delay' | 'succeeded' | 'failed' | 'cancelled'

export interface WorkflowRun {
  id: string
  workflowId: string
  status: RunStatus
  input: Record<string, unknown>
  /** Node to execute next (or the one waiting). */
  cursor?: string | undefined
  outputs: Record<string, string>
  log: { node: string, at: string, ok: boolean, note: string }[]
  resumeAt?: string | undefined
  error?: string | undefined
  startedAt: string
  updatedAt: string
}

export interface EngineDeps {
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean, text: string }>
  runAgent?: ((prompt: string, signal?: AbortSignal) => Promise<string>) | undefined
  save(run: WorkflowRun): Promise<void>
  now?: () => Date
  maxSteps?: number
}

export function validate(wf: Pick<Workflow, 'start' | 'nodes'>): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const n of wf.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`)
    ids.add(n.id)
  }
  if (!ids.has(wf.start)) errors.push(`start node ${wf.start} does not exist`)
  for (const n of wf.nodes) {
    const targets = n.kind === 'condition' ? [n.then, n.else] : [n.next]
    for (const t of targets) if (t && !ids.has(t)) errors.push(`${n.id} points to missing node ${t}`)
    if (n.kind === 'condition' && !n.test.contains && !n.test.regex && n.test.equals === undefined) errors.push(`${n.id} has an empty test`)
    if (n.kind === 'condition' && n.test.regex) { try { new RegExp(n.test.regex) } catch { errors.push(`${n.id} has an invalid regex`) } }
    if (n.kind === 'delay' && !(n.ms >= 0)) errors.push(`${n.id} has an invalid delay`)
  }
  return errors
}

/** Replace `{{node}}`, `{{node.output}}` and `{{input.key}}` in strings, recursively. */
export function template(value: unknown, run: Pick<WorkflowRun, 'outputs' | 'input'>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w-]+)(?:\.([\w-]+))?\s*\}\}/g, (m, a: string, b?: string) => {
      if (a === 'input') return b !== undefined && run.input[b] !== undefined ? String(run.input[b]) : m
      return run.outputs[a] ?? m
    })
  }
  if (Array.isArray(value)) return value.map((v) => template(v, run))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, run)]))
  return value
}

export function newRun(wf: Workflow, input: Record<string, unknown> = {}, now = new Date()): WorkflowRun {
  return { id: randomUUID().slice(0, 8), workflowId: wf.id, status: 'running', input, cursor: wf.start, outputs: {}, log: [], startedAt: now.toISOString(), updatedAt: now.toISOString() }
}

/**
 * Advance a run until it finishes or pauses. Safe to call again on a paused
 * run: approvals must be granted via {@link approve} first; delays resume
 * once `resumeAt` has passed.
 */
export async function advance(wf: Workflow, run: WorkflowRun, deps: EngineDeps, signal?: AbortSignal): Promise<WorkflowRun> {
  const now = () => deps.now?.() ?? new Date()
  const byId = new Map(wf.nodes.map((n) => [n.id, n]))
  const note = async (node: string, ok: boolean, text: string) => {
    run.log.push({ node, at: now().toISOString(), ok, note: text.slice(0, 500) })
    run.updatedAt = now().toISOString()
    await deps.save(run)
  }
  if (run.status === 'waiting-approval') return run
  if (run.status === 'waiting-delay') {
    if (run.resumeAt && new Date(run.resumeAt) > now()) return run
    run.status = 'running'
    run.resumeAt = undefined
  }
  if (run.status !== 'running') return run

  let steps = 0
  let last = ''
  while (run.cursor) {
    if (signal?.aborted) { run.status = 'cancelled'; await note(run.cursor, false, 'cancelled'); return run }
    if (++steps > (deps.maxSteps ?? 200)) { run.status = 'failed'; run.error = 'step limit reached (loop?)'; await note(run.cursor, false, run.error); return run }
    const node = byId.get(run.cursor)
    if (!node) { run.status = 'failed'; run.error = `missing node ${run.cursor}`; await note(run.cursor, false, run.error); return run }
    try {
      switch (node.kind) {
        case 'tool': {
          const r = await deps.callTool(node.tool, template(node.args ?? {}, run) as Record<string, unknown>, signal)
          run.outputs[node.id] = r.text
          last = r.text
          if (!r.ok) { run.status = 'failed'; run.error = `${node.tool} failed: ${r.text.slice(0, 200)}`; await note(node.id, false, run.error); return run }
          run.cursor = node.next
          await note(node.id, true, `${node.tool} ok`)
          break
        }
        case 'agent': {
          if (!deps.runAgent) throw new Error('no agent runner configured')
          const text = await deps.runAgent(String(template(node.prompt, run)), signal)
          run.outputs[node.id] = text
          last = text
          run.cursor = node.next
          await note(node.id, true, 'agent replied')
          break
        }
        case 'condition': {
          const input = node.input ? run.outputs[node.input] ?? '' : last
          const t = node.test
          const pass = (t.contains === undefined || input.includes(t.contains))
            && (t.regex === undefined || new RegExp(t.regex, 'i').test(input))
            && (t.equals === undefined || input.trim() === t.equals)
          run.outputs[node.id] = String(pass)
          run.cursor = pass ? node.then : node.else
          await note(node.id, true, pass ? 'then' : 'else')
          break
        }
        case 'approval': {
          run.status = 'waiting-approval'
          await note(node.id, true, `waiting for approval: ${String(template(node.message, run))}`)
          return run
        }
        case 'delay': {
          run.status = 'waiting-delay'
          run.resumeAt = new Date(now().getTime() + node.ms).toISOString()
          run.cursor = node.next
          await note(node.id, true, `paused until ${run.resumeAt}`)
          return run
        }
      }
    } catch (e) {
      run.status = 'failed'
      run.error = e instanceof Error ? e.message : String(e)
      await note(node.id, false, run.error)
      return run
    }
  }
  run.status = 'succeeded'
  run.updatedAt = now().toISOString()
  await deps.save(run)
  return run
}

/** Grant (or refuse) the approval a run is waiting on. */
export function approve(wf: Workflow, run: WorkflowRun, approved: boolean, now = new Date()): WorkflowRun {
  if (run.status !== 'waiting-approval' || !run.cursor) throw new Error(`run ${run.id} is not waiting for approval`)
  const node = wf.nodes.find((n) => n.id === run.cursor)
  if (node?.kind !== 'approval') throw new Error(`run ${run.id} cursor is not an approval node`)
  run.log.push({ node: node.id, at: now.toISOString(), ok: approved, note: approved ? 'approved by owner' : 'refused by owner' })
  run.outputs[node.id] = approved ? 'approved' : 'refused'
  run.updatedAt = now.toISOString()
  if (approved) {
    run.status = 'running'
    run.cursor = node.next
  } else {
    run.status = 'cancelled'
  }
  return run
}
