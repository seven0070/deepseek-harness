import { describe, expect, it } from 'vitest'
import { AgentComputer, shellQuote } from '../src/index.ts'
import { fakeDocker } from './fake-docker.ts'

describe('AgentComputer', () => {
  it('creates lazily with a persistent disk and a locked-down container', async () => {
    const docker = fakeDocker()
    const pc = new AgentComputer(docker.runner, { name: 'primary' })
    expect(await pc.state()).toBe('absent')
    const status = await pc.ensure()
    expect(status.state).toBe('running')
    expect(docker.volumes.has('dsh-computer-primary-home')).toBe(true)
    const run = docker.calls.find((c) => c.argv[1] === 'run')!.argv
    expect(run).toEqual(expect.arrayContaining(['--security-opt', 'no-new-privileges', '--network', 'bridge']))
    expect(run.join(' ')).toContain('type=volume,source=dsh-computer-primary-home,target=/home/agent')
    expect(run.join(' ')).not.toMatch(/--privileged|type=bind|-v /)
    expect(run.slice(-3)).toEqual(['ubuntu:24.04', 'sleep', 'infinity'])
  })

  it('is idempotent and restarts a stopped machine', async () => {
    const docker = fakeDocker()
    const pc = new AgentComputer(docker.runner, { name: 'a' })
    await Promise.all([pc.ensure(), pc.ensure(), pc.exec('true')])
    expect(docker.calls.filter((c) => c.argv[1] === 'run')).toHaveLength(1)
    await pc.stop()
    expect(await pc.state()).toBe('stopped')
    await pc.ensure()
    expect(await pc.state()).toBe('running')
    expect(docker.calls.filter((c) => c.argv[1] === 'run')).toHaveLength(1)
  })

  it('runs commands without host shell interpolation', async () => {
    const docker = fakeDocker()
    const pc = new AgentComputer(docker.runner, { name: 'a', execTimeoutMs: 5000 })
    const evil = 'echo $(whoami); rm -rf / # "quoted"'
    const result = await pc.exec(evil, { cwd: '/tmp' })
    expect(result.stdout).toBe(`ran: ${evil}`)
    const exec = docker.calls.find((c) => c.argv[1] === 'exec')!
    expect(exec.argv.slice(-3)).toEqual(['bash', '-lc', evil])
    expect(exec.argv).toContain('/tmp')
    expect(exec.options?.timeoutMs).toBe(5000)
  })

  it('writes files through stdin with a quoted path', async () => {
    const docker = fakeDocker()
    let seen: { command: string, input?: string } | undefined
    docker.execReply = (command, input) => { seen = { command, input }; return { code: 0, stdout: '', stderr: '' } }
    const pc = new AgentComputer(docker.runner, { name: 'a' })
    await pc.writeFile("/tmp/it's here.txt", 'hello')
    expect(seen!.input).toBe('hello')
    expect(seen!.command).toContain(shellQuote("/tmp/it's here.txt"))
  })

  it('snapshots and restores, including the disk', async () => {
    const docker = fakeDocker()
    const pc = new AgentComputer(docker.runner, { name: 'a' })
    await pc.ensure()
    const snap = await pc.snapshot('before-upgrade')
    expect(snap.image).toBe('dsh-computer/a:before-upgrade')
    expect(docker.calls.some((c) => c.argv.includes('/snapshots/before-upgrade.tgz'))).toBe(true)
    expect((await pc.snapshots()).map((s) => s.tag)).toEqual(['before-upgrade'])
    const restored = await pc.restore('before-upgrade')
    expect(restored.state).toBe('running')
    expect(restored.image).toBe('dsh-computer/a:before-upgrade')
    await expect(pc.restore('missing')).rejects.toThrow(/find snapshot missing/)
  })

  it('validates names and tags', async () => {
    const docker = fakeDocker()
    expect(() => new AgentComputer(docker.runner, { name: 'Bad Name' })).toThrow(/invalid name/)
    const pc = new AgentComputer(docker.runner, { name: 'a' })
    await expect(pc.snapshot('x; rm -rf /')).rejects.toThrow(/invalid snapshot tag/)
    await expect(pc.snapshot('ok')).rejects.toThrow(/does not exist/)
  })

  it('publishes the desktop on loopback only', async () => {
    const docker = fakeDocker()
    const pc = new AgentComputer(docker.runner, { name: 'd', desktop: true, network: 'none' })
    const status = await pc.ensure()
    const run = docker.calls.find((c) => c.argv[1] === 'run')!.argv
    expect(run).toEqual(expect.arrayContaining(['-p', '127.0.0.1:6080:3000', '--network', 'none']))
    expect(run.at(-1)).toContain('webtop')
    expect(status.desktopUrl).toBe('http://127.0.0.1:6080')
  })

  it('destroy keeps the disk unless wiped', async () => {
    const docker = fakeDocker()
    const pc = new AgentComputer(docker.runner, { name: 'a' })
    await pc.ensure()
    await pc.destroy()
    expect(docker.volumes.has(pc.disk)).toBe(true)
    await pc.destroy({ wipe: true })
    expect(docker.volumes.has(pc.disk)).toBe(false)
  })
})
