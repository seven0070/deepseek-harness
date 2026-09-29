/**
 * Tiny durable JSON persistence: atomic replace for documents, append for
 * logs. Every autonomy component persists through here so state survives
 * restarts and a crash mid-write never leaves a torn document.
 *
 * @module dsh-autonomy-core/store
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJson<T>(path: string | undefined): Promise<T | undefined> {
  if (!path) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export async function writeJsonAtomic(path: string | undefined, value: unknown): Promise<void> {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n')
  await rename(tmp, path)
}

export async function appendLine(path: string | undefined, value: unknown): Promise<void> {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(value) + '\n')
}

export async function readLines<T>(path: string | undefined): Promise<T[]> {
  if (!path) return []
  let text = ''
  try { text = await readFile(path, 'utf8') } catch { return [] }
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as T) } catch { /* torn tail line */ }
  }
  return out
}
