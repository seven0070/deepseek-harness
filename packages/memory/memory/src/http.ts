/**
 * Minimal JSON-over-HTTP helper shared by service-backed memory backends.
 *
 * @module dsh-memory/http
 */

export type FetchLike = (url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string | FormData
  signal?: AbortSignal | undefined
}) => Promise<{ ok: boolean, status: number, text(): Promise<string> }>

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string, headers?: Record<string, string>, json?: unknown, form?: FormData, signal?: AbortSignal | undefined },
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers }
  let body: string | FormData | undefined
  if (init.form) body = init.form
  else if (init.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const response = await fetchImpl(url, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    ...body === undefined ? {} : { body },
    signal: init.signal,
  })
  const text = await response.text()
  if (!response.ok) throw new HttpError(response.status, `${url} → HTTP ${response.status}: ${text.slice(0, 300)}`)
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}

export function defaultFetch(): FetchLike {
  return globalThis.fetch as unknown as FetchLike
}
