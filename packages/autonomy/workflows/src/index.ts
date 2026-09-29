/**
 * Agent-proposed, owner-approved workflows. The agent drafts a workflow
 * (`workflow_propose`); it runs only after the owner activates it
 * (`workflow_activate`, high risk). Runs are durable: state is saved after
 * every node, approval nodes pause until the owner approves
 * (`workflow_approve`, high risk), and delayed or scheduled runs resume on
 * their own. Every tool a workflow calls still passes the authorization gate.
 *
 * @module @deepseek-ai/dsh-workflows
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { advance, approve, newRun, validate } from './engine.ts'
import type { Workflow, WorkflowNode, WorkflowRun, WorkflowTrigger } from './engine.ts'

export * from './engine.ts'

interface ToolsLike {
  execute(input: { signal: AbortSignal, callId: ReturnType<typeof ToolCallId>, name: string, arguments: unknown }): Promise<{ isError: boolean, content: { type: string, text?: string }[] }>
}

export class WorkflowService {
  readonly workflows = new Map<string, Workflow>()
  readonly runs = new Map<string, WorkflowRun>()
  private readonly lastScheduled = new Map<string, number>()
  runAgent?: ((prompt: string, signal?: AbortSignal) => Promise<string>) | undefined

  constructor(private readonly options: { dir?: string | undefined, tools: () => ToolsLike | undefined, now?: () => Date }) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  async load(): Promise<void> {
    const dir = this.options.dir
    if (!dir) return
    try {
      for (const wf of JSON.parse(await readFile(join(dir, 'workflows.json'), 'utf8')) as Workflow[]) this.workflows.set(wf.id, wf)
    } catch {}
    try {
      for (const f of await readdir(join(dir, 'runs'))) {
        const run = JSON.parse(await readFile(join(dir, 'runs', f), 'utf8')) as WorkflowRun
        this.runs.set(run.id, run)
      }
    } catch {}
  }

  private async saveWorkflows(): Promise<void> {
    if (!this.options.dir) return
    await mkdir(this.options.dir, { recursive: true })
    await writeFile(join(this.options.dir, 'workflows.json'), JSON.stringify([...this.workflows.values()], null, 2))
  }

  private async saveRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, run)
    if (!this.options.dir) return
    await mkdir(join(this.options.dir, 'runs'), { recursive: true })
    await writeFile(join(this.options.dir, 'runs', `${run.id}.json`), JSON.stringify(run, null, 2))
  }

  async propose(input: { name: string, description: string, start: string, nodes: WorkflowNode[], trigger?: WorkflowTrigger }, by: 'agent' | 'owner' = 'agent'): Promise<Workflow> {
    const errors = validate(input)
    if (errors.length) throw new Error(`workflow is invalid: ${errors.join('; ')}`)
    const wf: Workflow = { id: randomUUID().slice(0, 8), name: input.name, description: input.description, start: input.start, nodes: input.nodes, trigger: input.trigger ?? { kind: 'manual' }, status: 'draft', createdBy: by, createdAt: this.now().toISOString() }
    this.workflows.set(wf.id, wf)
    await this.saveWorkflows()
    return wf
  }

  async setStatus(id: string, status: Workflow['status']): Promise<Workflow> {
    const wf = this.must(id)
    wf.status = status
    await this.saveWorkflows()
    return wf
  }

  async start(id: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<WorkflowRun> {
    const wf = this.must(id)
    if (wf.status !== 'active') throw new Error(`workflow ${wf.name} is ${wf.status}; it must be activated by the owner first`)
    const run = newRun(wf, input, this.now())
    await this.saveRun(run)
    return this.step(run, signal)
  }

  async approve(runId: string, approved: boolean, signal?: AbortSignal): Promise<WorkflowRun> {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`no run ${runId}`)
    approve(this.must(run.workflowId), run, approved, this.now())
    await this.saveRun(run)
    return this.step(run, signal)
  }

  /** Resume due delayed runs and start due scheduled workflows. */
  async tick(signal?: AbortSignal): Promise<void> {
    const now = this.now().getTime()
    for (const run of this.runs.values()) {
      if (run.status === 'waiting-delay' && run.resumeAt && new Date(run.resumeAt).getTime() <= now) await this.step(run, signal)
    }
    for (const wf of this.workflows.values()) {
      if (wf.status !== 'active' || wf.trigger.kind !== 'schedule' || !wf.trigger.everyMs) continue
      const last = this.lastScheduled.get(wf.id) ?? 0
      const busy = [...this.runs.values()].some((r) => r.workflowId === wf.id && (r.status === 'running' || r.status.startsWith('waiting')))
      if (!busy && now - last >= wf.trigger.everyMs) {
        this.lastScheduled.set(wf.id, now)
        await this.start(wf.id, {}, signal)
      }
    }
  }

  private step(run: WorkflowRun, signal?: AbortSignal): Promise<WorkflowRun> {
    const wf = this.must(run.workflowId)
    let n = 0
    return advance(wf, run, {
      save: (r) => this.saveRun(r),
      runAgent: this.runAgent,
      now: () => this.now(),
      callTool: async (name, args, sig) => {
        const tools = this.options.tools()
        if (!tools) return { ok: false, text: 'tool runtime unavailable' }
        const r = await tools.execute({ signal: sig ?? signal ?? new AbortController().signal, callId: ToolCallId(`wf-${run.id}-${run.cursor}-${++n}`), name, arguments: args })
        return { ok: !r.isError, text: r.content.map((b) => b.text ?? '').join('\n') }
      },
    }, signal)
  }

  must(id: string): Workflow {
    const wf = this.workflows.get(id) ?? [...this.workflows.values()].find((w) => w.name === id)
    if (!wf) throw new Error(`no workflow ${id}`)
    return wf
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflows: WorkflowService
  }
}

export const name = 'workflows'

export interface Config {
  dir?: string | undefined
  tickMs: number
}

export const Config: z<Config> = z.object({
  dir: z.string().description('Where workflows and runs persist; omitted = in-memory.'),
  tickMs: z.natural().default(5000).description('How often scheduled and delayed runs are checked.'),
}) as z<Config>

export async function apply(ctx: Context, config: Config): Promise<void> {
  const service = new WorkflowService({
    dir: config.dir?.replace(/^~(?=\/|$)/, homedir()),
    tools: () => ctx.get('tools') as ToolsLike | undefined,
  })
  await service.load()
  ctx.provide('workflows', service)
  const controller = new AbortController()
  let ticking = false
  const timer = setInterval(() => {
    if (ticking) return
    ticking = true
    void service.tick(controller.signal).catch(() => {}).finally(() => { ticking = false })
  }, config.tickMs)
  timer.unref?.()
  ctx.effect(() => () => { clearInterval(timer); controller.abort() })

  void ctx.plugin({
    name: 'workflow-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      const out = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } as const
      const render = (_a: unknown, v: { text: string }) => [{ type: 'text' as const, text: v.text }]
      const describeRun = (r: WorkflowRun) => `run ${r.id}: ${r.status}${r.cursor && r.status.startsWith('waiting') ? ` at ${r.cursor}` : ''}${r.error ? ` — ${r.error}` : ''}\n${r.log.slice(-8).map((l) => `  ${l.ok ? '✓' : '✗'} ${l.node}: ${l.note}`).join('\n')}`

      ctx.tools.register(defineTool({
        name: 'workflow_propose',
        description: 'Draft a reusable workflow: a graph of nodes (tool, agent, condition, approval, delay) that can run on demand or on a schedule. '
          + 'Your owner reviews and activates it before it can run. Tool args may reference earlier outputs as {{nodeId}} and run input as {{input.key}}.',
        parameters: {
          name: { type: 'string', required: true },
          description: { type: 'string', required: true },
          start: { type: 'string', required: true, description: 'Id of the first node.' },
          nodes: {
            type: 'json',
            required: true,
            description: 'Array of nodes, e.g. [{"id":"test","kind":"tool","tool":"bash","args":{"command":"pnpm test"},"next":"check"},'
              + '{"id":"check","kind":"condition","test":{"regex":"fail"},"then":"ask","else":"done"},{"id":"ask","kind":"approval","message":"Tests failed; open an issue?"}]',
          },
          everyMs: { type: 'integer', description: 'Run on a schedule every N milliseconds (omit for manual).' },
        },
        output: { schema: out, render },
        async execute(args) {
          if (!Array.isArray(args.nodes)) throw new Error('nodes must be an array')
          const wf = await service.propose({
            name: args.name, description: args.description, start: args.start, nodes: args.nodes as unknown as WorkflowNode[],
            trigger: args.everyMs ? { kind: 'schedule', everyMs: args.everyMs } : { kind: 'manual' },
          })
          const lines = wf.nodes.map((n) => `  ${n.id} [${n.kind}]${n.kind === 'tool' ? ` ${n.tool}` : ''}`)
          return { text: `Drafted workflow ${wf.id} "${wf.name}" (${wf.trigger.kind}${wf.trigger.everyMs ? ` every ${wf.trigger.everyMs} ms` : ''}):\n${lines.join('\n')}\nAsk your owner to review it; workflow_activate turns it on.` }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'workflow_activate',
        description: 'Activate a drafted workflow so it can run (and start its schedule). Requires your owner\'s approval.',
        parameters: { id: { type: 'string', required: true } },
        output: { schema: out, render },
        async execute(args) {
          const wf = await service.setStatus(args.id, 'active')
          return { text: `Workflow ${wf.name} is active.` }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'workflow_disable',
        description: 'Disable a workflow (stops its schedule).',
        parameters: { id: { type: 'string', required: true } },
        output: { schema: out, render },
        async execute(args) {
          const wf = await service.setStatus(args.id, 'disabled')
          return { text: `Workflow ${wf.name} is disabled.` }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'workflow_run',
        description: 'Run an active workflow now.',
        parameters: {
          id: { type: 'string', required: true, description: 'Workflow id or name.' },
          input: { type: 'object', additionalProperties: true, description: 'Values available as {{input.key}}.' },
        },
        output: { schema: out, render },
        async execute(args, exec) {
          const run = await service.start(args.id, (args.input ?? {}) as Record<string, unknown>, exec.signal)
          return { text: describeRun(run) }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'workflow_approve',
        description: 'Approve or refuse the approval step a workflow run is waiting on. Requires your owner\'s approval.',
        parameters: { runId: { type: 'string', required: true }, approved: { type: 'boolean', required: true } },
        output: { schema: out, render },
        async execute(args, exec) {
          return { text: describeRun(await service.approve(args.runId, args.approved, exec.signal)) }
        },
      }))

      ctx.tools.register(defineTool({
        name: 'workflow_status',
        description: 'List workflows and recent runs, including runs waiting for approval.',
        parameters: { runId: { type: 'string', description: 'Show one run in detail.' } },
        output: { schema: out, render },
        async execute(args) {
          if (args.runId) {
            const r = service.runs.get(args.runId)
            return { text: r ? describeRun(r) : `No run ${args.runId}.` }
          }
          const wfs = [...service.workflows.values()].map((w) => `  ${w.id} ${w.name} [${w.status}] ${w.trigger.kind}${w.trigger.everyMs ? ` every ${w.trigger.everyMs}ms` : ''}`)
          const runs = [...service.runs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)
            .map((r) => `  ${r.id} ${service.workflows.get(r.workflowId)?.name ?? r.workflowId}: ${r.status}`)
          return { text: `Workflows:\n${wfs.join('\n') || '  none'}\nRecent runs:\n${runs.join('\n') || '  none'}` }
        },
      }))
    },
  })
}
