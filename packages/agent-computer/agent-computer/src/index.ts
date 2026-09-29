/**
 * The agent's own computer. Mounting this plugin gives the agent a dedicated,
 * persistent machine — its own OS, disk, packages, and (optionally) desktop —
 * instead of borrowing the user's. The machine is created lazily on first use,
 * survives restarts, and can be checkpointed and restored.
 *
 * ```yaml
 * - id: agent-computer
 *   name: '@deepseek-ai/dsh-agent-computer'
 *   config:
 *     name: primary          # one computer per agent identity
 *     network: bridge        # or `none` for an offline machine
 *     desktop: false         # true: XFCE desktop at http://127.0.0.1:6080
 *     modelRestore: false    # let the model roll its own machine back
 * ```
 *
 * Other plugins reach it through `ctx.agentComputer`.
 *
 * @module @deepseek-ai/dsh-agent-computer
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AgentComputer, DEFAULTS } from './computer.ts'
import type { ExecResult } from './computer.ts'
import { spawnRunner } from './runner.ts'
import type { CommandRunner } from './runner.ts'

export * from './computer.ts'
export * from './runner.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentComputer: AgentComputer
  }
}

export const name = 'agent-computer'
export const inject = ['tools']

export interface Config {
  /** Agent identity; one computer per name. */
  name: string
  /** Container engine binary (docker or podman). */
  engine: string
  /** Image for the shell computer. */
  image: string
  /** Run a desktop reachable at 127.0.0.1:desktopPort. */
  desktop: boolean
  /** Image used when the desktop is on. */
  desktopImage: string
  /** Host port for the desktop's web view (bound to 127.0.0.1 only). */
  desktopPort: number
  /** Container network mode; `none` cuts the computer off from the network. */
  network: string
  /** CPU limit, in cores. */
  cpus: number
  /** Memory limit in engine syntax, for example `4g`. */
  memory: string
  /** Longest a single command may run before it is killed, in milliseconds. */
  execTimeoutMs: number
  /** Expose snapshot restore to the model. */
  modelRestore: boolean
  /** Test seam; not part of the persisted schema. */
  runner?: CommandRunner
}

export const Config: z<Config> = z.object({
  name: z.string().default('primary').description('Agent identity; one computer per name.'),
  engine: z.union(['docker', 'podman']).default(DEFAULTS.engine as 'docker'),
  image: z.string().default(DEFAULTS.image),
  desktop: z.boolean().default(DEFAULTS.desktop).description('Run a desktop reachable at 127.0.0.1:desktopPort.'),
  desktopImage: z.string().default(DEFAULTS.desktopImage),
  desktopPort: z.natural().default(DEFAULTS.desktopPort),
  network: z.union(['bridge', 'none']).default(DEFAULTS.network as 'bridge'),
  cpus: z.number().min(0.1).default(DEFAULTS.cpus),
  memory: z.string().default(DEFAULTS.memory),
  execTimeoutMs: z.natural().default(DEFAULTS.execTimeoutMs),
  modelRestore: z.boolean().default(false).description('Expose snapshot restore to the model.'),
}) as z<Config>

/** Keep tool output inside a model-friendly budget; the tail matters most. */
const TOOL_OUTPUT_CHARS = 30_000
function clip(text: string): string {
  return text.length <= TOOL_OUTPUT_CHARS ? text : `…[${text.length - TOOL_OUTPUT_CHARS} chars truncated]\n${text.slice(-TOOL_OUTPUT_CHARS)}`
}

const execOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    exitCode: { type: 'integer', required: true },
    stdout: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
    timedOut: { type: 'boolean', required: true },
  },
} as const

const statusOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', required: true },
    container: { type: 'string', required: true },
    disk: { type: 'string', required: true },
    image: { type: 'string' },
    desktopUrl: { type: 'string' },
  },
} as const

function execValue(result: ExecResult) {
  return { exitCode: result.code, stdout: clip(result.stdout), stderr: clip(result.stderr), timedOut: !!result.timedOut }
}

type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] }
  & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> }

/** Drop undefined fields so results satisfy exact optional property types. */
function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Compact<T>
}

export function apply(ctx: Context, config: Config): void {
  const { runner = spawnRunner, modelRestore, ...options } = config
  const computer = new AgentComputer(runner, options)
  ctx.provide('agentComputer', computer)

  ctx.tools.register(defineTool({
    name: 'computer_exec',
    description: 'Run a bash command on YOUR OWN persistent computer (a dedicated Linux machine, not the user\'s). '
      + 'Installed packages and files under the home directory persist across sessions. '
      + 'Use it for experiments, installing tools, and long-lived work.',
    parameters: {
      command: { type: 'string', required: true, description: 'Bash command line.' },
      cwd: { type: 'string', description: 'Working directory; defaults to your home.' },
      timeoutSeconds: { type: 'integer', description: 'Kill the command after this many seconds.' },
    },
    output: {
      schema: execOutput,
      render: (_args, value) => [{
        type: 'text',
        text: `exit ${value.exitCode}${value.timedOut ? ' (timed out)' : ''}\n${value.stdout}${value.stderr ? `\n[stderr]\n${value.stderr}` : ''}`,
      }],
    },
    async execute(args) {
      return execValue(await computer.exec(args.command, compact({
        cwd: args.cwd,
        timeoutMs: args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined,
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_write_file',
    description: 'Write a text file on your own computer, creating parent directories.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path, or relative to your home.' },
      content: { type: 'string', required: true, description: 'Full file content.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { bytes: { type: 'integer', required: true } } },
      render: (args, value) => [{ type: 'text', text: `Wrote ${value.bytes} bytes to ${args.path}` }],
    },
    async execute(args) {
      await computer.writeFile(args.path, args.content)
      return { bytes: Buffer.byteLength(args.content) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_read_file',
    description: 'Read a text file from your own computer.',
    parameters: { path: { type: 'string', required: true, description: 'Absolute path, or relative to your home.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args) {
      return { content: clip(await computer.readFile(args.path)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_status',
    description: 'Show whether your own computer exists and is running, and its desktop URL if any.',
    parameters: {},
    output: {
      schema: statusOutput,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const { name: _name, ...status } = await computer.status()
      return compact(status)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_snapshot',
    description: 'Checkpoint your computer (system and disk) under a tag before risky changes.',
    parameters: { tag: { type: 'string', required: true, description: 'Letters, digits, `_`, `.`, `-`.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tag: { type: 'string', required: true }, image: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Snapshot ${value.tag} saved as ${value.image}` }],
    },
    async execute(args) {
      const { tag, image } = await computer.snapshot(args.tag)
      return { tag, image }
    },
  }))

  if (modelRestore) {
    ctx.tools.register(defineTool({
      name: 'computer_restore',
      description: 'Roll your computer back to a snapshot. Everything since that snapshot is lost.',
      parameters: { tag: { type: 'string', required: true } },
      output: { schema: statusOutput, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) {
        const { name: _name, ...status } = await computer.restore(args.tag)
        return compact(status)
      },
    }))
  }
}
