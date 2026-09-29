/**
 * The one seam through which the computer touches the host: run an argv and
 * collect its output. Production spawns the container CLI; tests inject a
 * recording fake, so every lifecycle rule is checkable without Docker.
 *
 * @module dsh-agent-computer/runner
 */
import { spawn } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

export interface RunOptions {
  input?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export type CommandRunner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>

/** Output beyond this is truncated so a runaway command cannot exhaust memory. */
export const MAX_OUTPUT_BYTES = 1_000_000

/** Spawn `argv[0]` without a shell; arguments are never interpolated. */
export const spawnRunner: CommandRunner = (argv, options = {}) => new Promise((resolve) => {
  const [command, ...args] = argv
  const child = spawn(command!, args, { stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const cap = (buffer: string, chunk: Buffer): string =>
    buffer.length >= MAX_OUTPUT_BYTES ? buffer : (buffer + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES)
  child.stdout.on('data', (chunk: Buffer) => { stdout = cap(stdout, chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr = cap(stderr, chunk) })
  const timer = options.timeoutMs
    ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs)
    : undefined
  child.on('error', (error) => {
    if (timer) clearTimeout(timer)
    resolve({ code: 127, stdout, stderr: stderr + String(error.message) })
  })
  child.on('close', (code) => {
    if (timer) clearTimeout(timer)
    resolve({ code: code ?? 137, stdout, stderr, ...timedOut ? { timedOut } : {} })
  })
  if (options.input !== undefined) child.stdin.end(options.input)
  else child.stdin.end()
})
