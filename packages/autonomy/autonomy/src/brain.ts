/**
 * The model-backed "brain" for the executive: a planner that turns a goal
 * into a step graph, and a delegate that works through a free-form step by
 * choosing tools one at a time. Both speak strict JSON to the model and
 * validate everything it returns; every tool call still goes through the
 * normal tool runtime, so the authorization gate applies.
 *
 * @module dsh-autonomy/brain
 */
import type { ActResult, Goal, Plan, Step } from '@deepseek-ai/dsh-executive'
import { makePlan } from '@deepseek-ai/dsh-executive'

export type Complete = (request: { system: string, prompt: string, maxTokens?: number, signal?: AbortSignal }) => Promise<string>

export interface ToolInfo {
  name: string
  description: string
}

/** Pull the first JSON object out of model text (tolerates code fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1]! : text
  const start = body.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(body.slice(start, i + 1)) } catch { return undefined }
    }
  }
  return undefined
}

const toolList = (tools: readonly ToolInfo[]): string => tools.map((t) => `- ${t.name}: ${(t.description.split('\n')[0] ?? '').slice(0, 160)}`).join('\n')
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const PLANNER_SYSTEM = `You are the planning module of an autonomous agent. Turn the goal into a short plan.
Reply with ONLY a JSON object:
{"steps":[{"id":"s1","description":"...","tool":"optional tool name","args":{},"check":{"tool":"...","args":{}},"dependsOn":["..."]}]}
Rules:
- 1 to 8 steps. Ids are short and unique. dependsOn only names other steps in this plan.
- Give "tool" and "args" only when one known tool call fully does the step; otherwise leave them out and describe the step, it will be worked through later.
- Add a "check" when a tool can verify that the step worked (for example running the tests).
- Use only tools from the list. Never plan to change the agent's safety core.`

export function makePlanner(options: { complete: Complete, tools: (goal: Goal) => readonly ToolInfo[], maxSteps?: number }) {
  return async (goal: Goal, context: string, signal: AbortSignal): Promise<Plan | undefined> => {
    const tools = options.tools(goal)
    const known = new Set(tools.map((t) => t.name))
    const prompt = `Goal: ${goal.title}
Success criteria: ${goal.successCriteria.join('; ') || '(none given)'}
${context ? `What you remember:\n${context}\n` : ''}
Tools you can use:
${toolList(tools)}`
    const raw = extractJson(await options.complete({ system: PLANNER_SYSTEM, prompt, maxTokens: 2000, signal }))
    if (!isObj(raw) || !Array.isArray(raw.steps) || !raw.steps.length) return undefined
    const steps = raw.steps.slice(0, options.maxSteps ?? 8).filter(isObj).map((s, i) => {
      const id = typeof s.id === 'string' && s.id ? s.id : `s${i + 1}`
      const tool = typeof s.tool === 'string' && known.has(s.tool) ? s.tool : undefined
      const check = isObj(s.check) && typeof s.check.tool === 'string' && known.has(s.check.tool)
        ? { tool: s.check.tool, args: isObj(s.check.args) ? s.check.args : {} }
        : undefined
      return {
        id,
        description: typeof s.description === 'string' && s.description ? s.description : (tool ?? id),
        ...tool ? { action: { tool, args: isObj(s.args) ? s.args : {} } } : {},
        ...check ? { check } : {},
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      }
    })
    const ids = new Set(steps.map((s) => s.id))
    for (const s of steps) s.dependsOn = s.dependsOn.filter((d) => ids.has(d) && d !== s.id)
    try {
      return makePlan(goal.id, steps as never)
    } catch {
      // Duplicate ids or a cycle: fall back to a simple sequence.
      return makePlan(goal.id, steps.map((s, i) => ({ ...s, id: `s${i + 1}`, dependsOn: i ? [`s${i}`] : [] })) as never)
    }
  }
}

const DELEGATE_SYSTEM = `You are an autonomous agent working through one step of a plan by using tools.
Each turn reply with ONLY one JSON object, either
{"tool":"name","args":{}}   to call a tool, or
{"done":true,"ok":true,"result":"what you achieved"}   when the step is finished (ok:false if it cannot be done).
Use only listed tools. If a tool call is refused or waits for approval, do not look for another way to do the same thing: finish with ok:false and say why.`

export interface DelegateOptions {
  complete: Complete
  tools: (step: Step, goal: Goal) => readonly ToolInfo[]
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ActResult>
  maxTurns?: number
}

export function makeDelegate(options: DelegateOptions) {
  return async (step: Step, goal: Goal, context: string, signal: AbortSignal): Promise<ActResult> => {
    const tools = options.tools(step, goal)
    const known = new Set(tools.map((t) => t.name))
    const history: string[] = []
    const max = options.maxTurns ?? 6
    for (let turn = 1; turn <= max; turn++) {
      signal.throwIfAborted()
      const prompt = `Goal: ${goal.title}
Step: ${step.description}
${context ? `What you remember:\n${context}\n` : ''}
Tools:
${toolList(tools)}
${history.length ? `\nSo far:\n${history.join('\n')}` : ''}
Turn ${turn} of ${max}.`
      const text = await options.complete({ system: DELEGATE_SYSTEM, prompt, maxTokens: 1500, signal })
      const reply = extractJson(text)
      if (!isObj(reply)) {
        if (turn === max) return { ok: false, text: 'model did not return an action' }
        history.push('(your last reply was not valid JSON; reply with one JSON object)')
        continue
      }
      if (reply.done === true) return { ok: reply.ok !== false, text: typeof reply.result === 'string' ? reply.result : 'done' }
      if (typeof reply.tool !== 'string' || !known.has(reply.tool)) {
        history.push(`(unknown tool ${JSON.stringify(reply.tool)}; use one from the list)`)
        continue
      }
      const args = isObj(reply.args) ? reply.args : {}
      const r = await options.callTool(reply.tool, args, signal)
      history.push(`${reply.tool}(${JSON.stringify(args).slice(0, 300)}) → ${r.ok ? 'ok' : 'FAILED'}: ${r.text.slice(0, 800)}`)
    }
    return { ok: false, text: `step not finished after ${max} turns` }
  }
}

/** Run a free-form prompt as a one-step task (used by workflow agent nodes). */
export function makeAgentRunner(delegate: ReturnType<typeof makeDelegate>) {
  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    const now = new Date().toISOString()
    const goal: Goal = { id: 'workflow', title: prompt, successCriteria: [], status: 'active', priority: 0, createdBy: 'owner', createdAt: now, updatedAt: now, notes: [] } as unknown as Goal
    const step: Step = { id: 'w1', description: prompt, dependsOn: [], status: 'running', attempts: 1, maxAttempts: 1 }
    const r = await delegate(step, goal, '', signal ?? new AbortController().signal)
    if (!r.ok) throw new Error(r.text)
    return r.text
  }
}
