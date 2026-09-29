/** A small in-memory Docker: enough state to check lifecycle rules offline. */
import type { CommandRunner, RunOptions } from '../src/runner.ts'

export interface FakeDocker {
  runner: CommandRunner
  calls: { argv: string[], options?: RunOptions }[]
  containers: Map<string, { running: boolean, image: string }>
  volumes: Set<string>
  images: Set<string>
  execReply: (command: string, input?: string) => { code: number, stdout: string, stderr: string }
}

export function fakeDocker(): FakeDocker {
  const fake: FakeDocker = {
    calls: [],
    containers: new Map(),
    volumes: new Set(),
    images: new Set(),
    execReply: (command) => ({ code: 0, stdout: `ran: ${command}`, stderr: '' }),
    runner: async (argv, options) => {
      fake.calls.push({ argv: [...argv], ...options ? { options } : {} })
      const [, verb, ...rest] = argv
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
      const fail = (stderr: string) => ({ code: 1, stdout: '', stderr })
      const last = rest[rest.length - 1]!
      switch (verb) {
        case 'inspect': {
          const c = fake.containers.get(last)
          if (!c) return fail('No such object')
          return ok(rest[1] === '{{.State.Running}}' ? String(c.running) : c.image)
        }
        case 'volume':
          if (rest[0] === 'create') fake.volumes.add(last)
          if (rest[0] === 'rm') for (const v of rest.slice(2)) fake.volumes.delete(v)
          return ok()
        case 'run': {
          if (rest.includes('--rm')) return ok()
          const name = rest[rest.indexOf('--name') + 1]!
          const image = rest.find((a, i) => i > 0 && !a.startsWith('-') && !rest[i - 1]!.startsWith('-') && a.includes(':') && !a.includes('=') && !a.startsWith('127.'))!
          fake.containers.set(name, { running: true, image })
          return ok('id')
        }
        case 'start': fake.containers.get(last)!.running = true; return ok()
        case 'stop': fake.containers.get(last)!.running = false; return ok()
        case 'rm': fake.containers.delete(last); return ok()
        case 'commit': fake.images.add(last); return ok()
        case 'image': return fake.images.has(last) ? ok() : fail('No such image')
        case 'images': return ok([...fake.images].map((i) => `${i.split(':')[1]}\t2026-09-29`).join('\n'))
        case 'exec': {
          const command = argv[argv.length - 1]!
          return fake.execReply(command, options?.input)
        }
        default: return fail(`unknown verb ${verb}`)
      }
    },
  }
  return fake
}
