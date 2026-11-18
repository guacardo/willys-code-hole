import { createHash } from 'node:crypto'

const CODE = /\.(m|c)?(t|j)sx?$/

const TOP = [
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:declare\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/,
  /^(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/,
]

const MEMBER =
  /^\s+(?:(?:public|private|protected|static|readonly|abstract|override|declare|async|get|set)\s+)*#?([A-Za-z_$][\w$]*)\s*[?!]?\s*[(<:=]/
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'constructor', 'super', 'await', 'case', 'else', 'do', 'try', 'new', 'throw', 'typeof'])

function strip(line: string): string {
  return line
    .replace(/([=(,:!&|?{};]\s*|^\s*|return\s+)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+\/[dgimsuy]*/g, '$1""')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""')
    .replace(/\/\/.*$/, '')
}

/** Top-level declarations and class members of a TS/JS file, keyed `Name` or `Class.member`, each mapped to a hash of its text. */
export function symbolsOf(file: string, source: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!CODE.test(file)) return out
  const lines = source.split('\n')
  let depth = 0
  let cls: { name: string; depth: number } | null = null
  let open: { key: string; start: number; depth: number }[] = []
  let inBlockComment = false

  const close = (i: number) => {
    open = open.filter((o) => {
      if (depth > o.depth) return true
      out.set(o.key, hash(lines.slice(o.start, i + 1).join('\n')))
      return false
    })
  }

  for (let i = 0; i < lines.length; i++) {
    let line = strip(lines[i])
    if (inBlockComment) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      line = line.slice(end + 2)
      inBlockComment = false
    }
    line = line.replace(/\/\*.*?\*\//g, '')
    const bc = line.indexOf('/*')
    if (bc >= 0) {
      line = line.slice(0, bc)
      inBlockComment = true
    }

    if (depth === 0) {
      for (const re of TOP) {
        const m = re.exec(line)
        if (m) {
          if (/\bclass\s/.test(line)) {
            cls = { name: m[1], depth: 0 }
            out.set(m[1], hash(line))
          } else open.push({ key: m[1], start: i, depth: 0 })
          break
        }
      }
    } else if (cls && depth === cls.depth + 1) {
      const m = MEMBER.exec(line)
      if (m && !KEYWORDS.has(m[1])) open.push({ key: `${cls.name}.${m[1]}`, start: i, depth })
      else if (/^\s+constructor\s*\(/.test(line)) open.push({ key: `${cls.name}.constructor`, start: i, depth })
    }

    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth++
      else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    }
    if (cls && depth <= cls.depth && i > 0 && /[}]/.test(line)) cls = null
    if (!/[=,{([|&]\s*$/.test(line)) close(i)
  }
  close(lines.length - 1)
  return out
}

function hash(s: string): string {
  return createHash('sha1').update(s.replace(/\s+/g, ' ')).digest('hex').slice(0, 12)
}

export function diffSymbols(before: Map<string, string>, after: Map<string, string>) {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [k, h] of after) {
    const prev = before.get(k)
    if (prev === undefined) added.push(k)
    else if (prev !== h) changed.push(k)
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k)
  return { added, removed, changed }
}

/** `defineParam` matches `defineParam` and `GainEngine.defineParam`; `GainEngine.tick` matches only itself. */
export function symbolMatches(planned: string, key: string): boolean {
  return key === planned || key.endsWith(`.${planned}`) || planned.endsWith(`.${key}`)
}
