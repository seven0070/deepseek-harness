/**
 * Token compression for tool output (idea from OpenHuman's "tinyjuice",
 * re-implemented). Lossy but conservative, applied before output reaches the
 * model:
 *
 *  - strip ANSI escapes and carriage-return progress redraws;
 *  - trim trailing whitespace and collapse runs of blank lines;
 *  - fold runs of identical (or number-only-different) lines into one line
 *    plus a count;
 *  - for very long output keep the head and tail, and every line in between
 *    that looks important (errors, warnings, failures, stack frames).
 *
 * Output below `minChars` is returned untouched.
 *
 * @module dsh-efficiency/compress
 */

export interface CompressOptions {
  /** Leave shorter text alone. */
  minChars?: number
  /** Target maximum; head/tail + important lines are kept beyond this. */
  maxChars?: number
  headLines?: number
  tailLines?: number
  /** Cap on important lines kept from the elided middle. */
  maxImportant?: number
}

export interface Compressed {
  text: string
  before: number
  after: number
  changed: boolean
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const IMPORTANT = /\b(error|err!|fail(ed|ure)?|fatal|panic|exception|traceback|warn(ing)?|denied|refused|timeout|cannot|not found|undefined|assert)\b|^\s+at\s|^\s*File ".*", line \d+|^[-+]{3}\s|^@@/i

const shape = (line: string): string => line.replace(/\d+(\.\d+)?/g, '#')

export function compress(input: string, options: CompressOptions = {}): Compressed {
  const before = input.length
  const minChars = options.minChars ?? 2000
  if (before < minChars) return { text: input, before, after: before, changed: false }

  // 1. Escapes and progress redraws (keep the last segment after \r).
  let lines = input.replace(ANSI, '').split('\n').map((l) => {
    const cr = l.lastIndexOf('\r')
    return (cr >= 0 ? l.slice(cr + 1) : l).replace(/\s+$/, '')
  })

  // 2. Collapse blank runs and fold repeated shapes.
  const folded: string[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    if (!line) {
      if (folded.at(-1) !== '') folded.push('')
      i++
      continue
    }
    let j = i + 1
    while (j < lines.length && lines[j] && shape(lines[j]!) === shape(line)) j++
    const n = j - i
    if (n >= 3) folded.push(line, `  … ${n - 1} similar line${n - 1 > 1 ? 's' : ''} omitted`)
    else for (let x = i; x < j; x++) folded.push(lines[x]!)
    i = j
  }
  lines = folded

  // 3. Head / important middle / tail when still too long.
  const maxChars = options.maxChars ?? 12_000
  let text = lines.join('\n')
  if (text.length > maxChars) {
    const head = options.headLines ?? 60
    const tail = options.tailLines ?? 80
    if (lines.length > head + tail) {
      const middle = lines.slice(head, lines.length - tail)
      const important = middle.filter((l) => IMPORTANT.test(l)).slice(0, options.maxImportant ?? 60)
      const dropped = middle.length - important.length
      text = [
        ...lines.slice(0, head),
        `  … ${dropped} lines omitted${important.length ? `; ${important.length} important lines kept below` : ''} …`,
        ...important,
        ...important.length ? ['  …'] : [],
        ...lines.slice(lines.length - tail),
      ].join('\n')
    }
  }
  return { text, before, after: text.length, changed: text.length < before }
}

/** Rough token estimate (≈4 chars/token for English and code). */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4)
