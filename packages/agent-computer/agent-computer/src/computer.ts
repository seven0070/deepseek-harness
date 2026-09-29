/**
 * The agent's own computer: one long-lived container per agent identity, a
 * named volume as its persistent disk, optional desktop, and image snapshots
 * for checkpoint / restore. The host filesystem is never mounted, the
 * container never runs privileged, and privilege escalation is disabled.
 *
 * @module dsh-agent-computer/computer
 */
import type { CommandRunner, RunResult } from './runner.ts'

export type ComputerState = 'absent' | 'running' | 'stopped'

export interface ComputerOptions {
  /** Agent identity; names the container, disk, and snapshot repository. */
  name: string
  /** Container CLI (`docker` or `podman`). */
  engine: string
  /** Base image for a fresh computer. */
  image: string
  /** Desktop image used instead of `image` when `desktop` is on. */
  desktopImage: string
  desktop: boolean
  /** Host port (bound to 127.0.0.1 only) for the desktop's web VNC. */
  desktopPort: number
  /** Port the desktop image serves web VNC on inside the container. */
  desktopContainerPort: number
  /** `bridge` for internet access, `none` for an offline computer. */
  network: string
  cpus: number
  memory: string
  /** Where the persistent disk is mounted inside the computer. */
  home: string
  /** Default per-command timeout. */
  execTimeoutMs: number
}

export const DEFAULTS: Omit<ComputerOptions, 'name'> = {
  engine: 'docker',
  image: 'ubuntu:24.04',
  desktopImage: 'lscr.io/linuxserver/webtop:ubuntu-xfce',
  desktop: false,
  desktopPort: 6080,
  desktopContainerPort: 3000,
  network: 'bridge',
  cpus: 2,
  memory: '4g',
  home: '/home/agent',
  execTimeoutMs: 120_000,
}

export interface ExecResult extends RunResult {
  command: string
}

export interface Snapshot {
  tag: string
  image: string
  created: string
}

export interface ComputerStatus {
  name: string
  state: ComputerState
  container: string
  disk: string
  image?: string | undefined
  desktopUrl?: string | undefined
}

const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/
const TAG = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/

/** Label every resource carries, so cleanup never touches foreign containers. */
export const LABEL = 'dev.deepseek.dsh.agent-computer'

export class AgentComputer {
  readonly options: ComputerOptions
  readonly container: string
  readonly disk: string
  readonly repository: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly run: CommandRunner, options: Partial<ComputerOptions> & { name: string }) {
    if (!NAME.test(options.name)) throw new Error(`agent-computer: invalid name ${JSON.stringify(options.name)}`)
    this.options = { ...DEFAULTS, ...options }
    this.container = `dsh-computer-${this.options.name}`
    this.disk = `dsh-computer-${this.options.name}-home`
    this.repository = `dsh-computer/${this.options.name}`
  }

  /** Lifecycle operations are serialized so two tool calls never race a create. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async engine(args: readonly string[], timeoutMs = 300_000): Promise<RunResult> {
    return this.run([this.options.engine, ...args], { timeoutMs })
  }

  private async must(args: readonly string[], what: string): Promise<RunResult> {
    const result = await this.engine(args)
    if (result.code !== 0) throw new Error(`agent-computer: ${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`)
    return result
  }

  async state(): Promise<ComputerState> {
    const result = await this.engine(['inspect', '-f', '{{.State.Running}}', this.container], 30_000)
    if (result.code !== 0) return 'absent'
    return result.stdout.trim() === 'true' ? 'running' : 'stopped'
  }

  async status(): Promise<ComputerStatus> {
    const state = await this.state()
    let image: string | undefined
    if (state !== 'absent') {
      const inspect = await this.engine(['inspect', '-f', '{{.Config.Image}}', this.container], 30_000)
      if (inspect.code === 0) image = inspect.stdout.trim()
    }
    return {
      name: this.options.name,
      state,
      container: this.container,
      disk: this.disk,
      image,
      desktopUrl: this.options.desktop && state === 'running' ? `http://127.0.0.1:${this.options.desktopPort}` : undefined,
    }
  }

  /** argv for `run`, from a given image. Exposed for review and tests. */
  createArgs(image: string): string[] {
    const o = this.options
    const args = [
      'run', '-d',
      '--name', this.container,
      '--hostname', o.name,
      '--label', `${LABEL}=${o.name}`,
      '--restart', 'unless-stopped',
      '--security-opt', 'no-new-privileges',
      '--network', o.network,
      '--cpus', String(o.cpus),
      '--memory', o.memory,
      '--pids-limit', '4096',
      '--mount', `type=volume,source=${this.disk},target=${o.home}`,
      '--workdir', o.home,
      '-e', `HOME=${o.home}`,
    ]
    if (o.desktop) args.push('-p', `127.0.0.1:${o.desktopPort}:${o.desktopContainerPort}`, '--shm-size', '1g')
    args.push(image)
    // The plain image has no long-running entrypoint; keep it alive.
    if (!o.desktop) args.push('sleep', 'infinity')
    return args
  }

  /** Create or start the computer; idempotent. */
  ensure(): Promise<ComputerStatus> {
    return this.serial(async () => {
      const state = await this.state()
      if (state === 'absent') {
        await this.must(['volume', 'create', '--label', `${LABEL}=${this.options.name}`, this.disk], 'disk create')
        await this.must(this.createArgs(this.options.desktop ? this.options.desktopImage : this.options.image), 'create')
      } else if (state === 'stopped') {
        await this.must(['start', this.container], 'start')
      }
      return this.status()
    })
  }

  /**
   * Run a shell command inside the computer. The command goes to `bash -lc`
   * as one argv element, so nothing is interpolated on the host.
   */
  async exec(command: string, options: { cwd?: string, timeoutMs?: number, input?: string } = {}): Promise<ExecResult> {
    await this.ensure()
    const args = [this.options.engine, 'exec', '-i', '-w', options.cwd ?? this.options.home, this.container, 'bash', '-lc', command]
    const result = await this.run(args, {
      timeoutMs: options.timeoutMs ?? this.options.execTimeoutMs,
      ...options.input === undefined ? {} : { input: options.input },
    })
    return { ...result, command }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const result = await this.exec(`p=${shellQuote(path)}; mkdir -p -- "$(dirname -- "$p")" && cat > "$p"`, { input: content })
    if (result.code !== 0) throw new Error(`agent-computer: write ${path} failed: ${result.stderr.trim()}`)
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec(`cat -- ${shellQuote(path)}`)
    if (result.code !== 0) throw new Error(`agent-computer: read ${path} failed: ${result.stderr.trim()}`)
    return result.stdout
  }

  stop(): Promise<ComputerStatus> {
    return this.serial(async () => {
      if (await this.state() === 'running') await this.must(['stop', this.container], 'stop')
      return this.status()
    })
  }

  /**
   * Checkpoint the system layer as an image. The persistent disk is a volume
   * and is not captured by `commit`, so it is archived alongside as a tarball
   * image layer via a helper container.
   */
  snapshot(tag: string): Promise<Snapshot> {
    if (!TAG.test(tag)) return Promise.reject(new Error(`agent-computer: invalid snapshot tag ${JSON.stringify(tag)}`))
    return this.serial(async () => {
      if (await this.state() === 'absent') throw new Error('agent-computer: nothing to snapshot; the computer does not exist')
      const image = `${this.repository}:${tag}`
      await this.must(['commit', '--pause=true', '--change', `LABEL ${LABEL}=${this.options.name}`, this.container, image], 'snapshot')
      await this.must(['run', '--rm', '--network', 'none', '--mount', `type=volume,source=${this.disk},target=/disk,readonly`,
        '--mount', `type=volume,source=${this.disk}-snapshots,target=/snapshots`,
        'busybox', 'tar', '-C', '/disk', '-czf', `/snapshots/${tag}.tgz`, '.'], 'disk snapshot')
      return { tag, image, created: new Date().toISOString() }
    })
  }

  async snapshots(): Promise<Snapshot[]> {
    const result = await this.engine(['images', this.repository, '--format', '{{.Tag}}\t{{.CreatedAt}}'], 30_000)
    if (result.code !== 0) return []
    return result.stdout.split('\n').filter(Boolean).map((line) => {
      const [tag = '', created = ''] = line.split('\t')
      return { tag, image: `${this.repository}:${tag}`, created }
    })
  }

  /** Replace the machine and its disk with a snapshot's contents. */
  restore(tag: string): Promise<ComputerStatus> {
    if (!TAG.test(tag)) return Promise.reject(new Error(`agent-computer: invalid snapshot tag ${JSON.stringify(tag)}`))
    return this.serial(async () => {
      const image = `${this.repository}:${tag}`
      await this.must(['image', 'inspect', image], `find snapshot ${tag}`)
      if (await this.state() !== 'absent') await this.must(['rm', '-f', this.container], 'remove')
      await this.must(['run', '--rm', '--network', 'none', '--mount', `type=volume,source=${this.disk},target=/disk`,
        '--mount', `type=volume,source=${this.disk}-snapshots,target=/snapshots,readonly`,
        'busybox', 'sh', '-c', `rm -rf /disk/..?* /disk/.[!.]* /disk/* && tar -C /disk -xzf /snapshots/${tag}.tgz`], 'disk restore')
      await this.must(this.createArgs(image), 'create from snapshot')
      return this.status()
    })
  }

  /** Remove the machine; the disk and snapshots survive unless `wipe` is set. */
  destroy(options: { wipe?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      if (await this.state() !== 'absent') await this.must(['rm', '-f', this.container], 'remove')
      if (options.wipe) {
        await this.engine(['volume', 'rm', '-f', this.disk, `${this.disk}-snapshots`])
      }
    })
  }
}

/** Single-quote for POSIX sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
