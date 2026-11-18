import type { GateResult, Signals } from '../../shared/types'

export type Call = { id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }

const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SEARCH = new Set(['Grep', 'Glob'])
const CHECK = /\b(vitest|jest|pytest|tsc|typecheck|eslint|lint|test(:run)?|cargo (test|check)|go (test|vet)|swift (test|build)|xcodebuild|mypy|ruff|pyright)\b/
const EXPLORE_BASH = /^\s*(ls|cat|head|tail|sed -n|grep|rg|find|tree|wc|git (log|show|status|diff|grep))\b/
const PROSE = /(^|\/)(CLAUDE|AGENTS)\.md$|\/memory\/[^/]+\.md$/
const GATE = /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc[^/]*|tsconfig[^/]*\.json|biome\.json|ruff\.toml|\.claude\/settings(\.local)?\.json)$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)hooks\//

const filePath = (c: Call) => String(c.input.file_path ?? c.input.notebook_path ?? '')
const failed = (c: Call) => c.isError === true || /^Exit code [1-9]/m.test(c.result ?? '')

/** Kinds of failure in checker output: TS error codes, eslint rule ids, failing test files. */
export function failureKinds(output: string): Record<string, number> {
  const kinds: Record<string, number> = {}
  const add = (k: string) => (kinds[k] = (kinds[k] ?? 0) + 1)
  for (const m of output.matchAll(/error (TS\d+)/g)) add(m[1])
  for (const m of output.matchAll(/^\s*\d+:\d+\s+(?:error|warning)\s+.*?\s{2,}(@?[\w-]+(?:\/[\w-]+)*)\s*$/gm)) add(`eslint:${m[1]}`)
  for (const m of output.matchAll(/^\s*(?:FAIL|×|✗)\s+(\S+\.(?:test|spec)\.\S+)/gm)) add(`test:${m[1]}`)
  return kinds
}

/** An edit that changes text an earlier edit in the same run wrote: a Write over its own file, or an old_string line it produced. */
function rewritesOwnText(tool: string, old: string, prior: { neu: string }[]): boolean {
  if (!prior.length) return false
  if (tool === 'Write') return true
  const lines = old.split('\n').map((l) => l.trim()).filter((l) => l.length > 8)
  return lines.some((l) => prior.some((p) => p.neu.includes(l)))
}

export function analyze(calls: Call[], gates: GateResult[] = []): Signals {
  const rewrites = new Map<string, number>()
  const priorEdits: { file: string; old: string; neu: string }[] = []
  let reverts = 0
  let checkFailures = 0
  let failFixLoops = 0
  let openFailure = false
  let duplicateCalls = 0
  let denials = 0
  const seen = new Set<string>()
  const failureKindsAll: Record<string, number> = {}
  const proseFixes = new Set<string>()
  const gateFixes = new Set<string>()
  const reads = new Map<string, number>()
  const readsSinceEdit = new Map<string, number>()
  const searches = new Map<string, number>()
  let orientationCalls = 0
  let orientationChars = 0
  let edited = false

  const mergeKinds = (k: Record<string, number>) => {
    for (const [name, n] of Object.entries(k)) failureKindsAll[name] = (failureKindsAll[name] ?? 0) + n
  }

  for (const c of calls) {
    const key = `${c.name}:${JSON.stringify(c.input)}`
    if (!EDIT.has(c.name) && seen.has(key)) duplicateCalls++
    seen.add(key)
    if (/denied/i.test(c.result ?? '') && c.isError) denials++

    if (EDIT.has(c.name)) {
      const file = filePath(c)
      edited = true
      readsSinceEdit.delete(file)
      const neu = String(c.input.new_string ?? c.input.content ?? '')
      const old = String(c.input.old_string ?? '')
      const mine = priorEdits.filter((p) => p.file === file)
      if (neu && mine.some((p) => p.old === neu && (p.neu === old || !old))) reverts++
      if (rewritesOwnText(c.name, old, mine)) rewrites.set(file, (rewrites.get(file) ?? 0) + 1)
      priorEdits.push({ file, old, neu })
      if (PROSE.test(file)) proseFixes.add(file)
      else if (GATE.test(file)) gateFixes.add(file)
    }

    if (c.name === 'Read') {
      const file = filePath(c)
      reads.set(file, (reads.get(file) ?? 0) + 1)
      readsSinceEdit.set(file, (readsSinceEdit.get(file) ?? 0) + 1)
    }
    if (SEARCH.has(c.name)) {
      const pattern = String(c.input.pattern ?? '')
      searches.set(pattern, (searches.get(pattern) ?? 0) + 1)
    }

    const cmd = c.name === 'Bash' ? String(c.input.command ?? '') : ''
    if (cmd && CHECK.test(cmd)) {
      if (failed(c)) {
        checkFailures++
        openFailure = true
        mergeKinds(failureKinds(c.result ?? ''))
      } else if (openFailure) {
        failFixLoops++
        openFailure = false
      }
    }

    if (!edited && (c.name === 'Read' || SEARCH.has(c.name) || (cmd && EXPLORE_BASH.test(cmd)))) {
      orientationCalls++
      orientationChars += (c.result ?? '').length
    }
  }
  for (const g of gates) if (!g.ok) mergeKinds(g.kinds)

  return {
    rework: {
      rewrites: [...rewrites].map(([file, n]) => ({ file, rewrites: n })).sort((a, b) => b.rewrites - a.rewrites),
      reverts,
      checkFailures: checkFailures + gates.filter((g) => !g.ok).length,
      failFixLoops,
      duplicateCalls,
      denials,
    },
    enforcement: { failureKinds: failureKindsAll, proseFixes: [...proseFixes], gateFixes: [...gateFixes] },
    memory: {
      rereads: [...reads].filter(([f]) => (readsSinceEdit.get(f) ?? 0) >= 2).map(([file, n]) => ({ file, reads: n })),
      repeatedSearches: [...searches].filter(([, n]) => n >= 2).map(([pattern, count]) => ({ pattern, count })),
      orientationCalls,
      orientationChars,
    },
    calls: calls.length,
  }
}

/** One number for the trend line: each rework event counts once. */
export const reworkScore = (s: Signals) =>
  (s.rework.rewrites ?? []).reduce((n, r) => n + r.rewrites, 0) + s.rework.reverts + s.rework.checkFailures + s.rework.duplicateCalls + s.rework.denials

/**
 * Deterministic next steps. Recurring failures point at a gate (lint rule, stricter type, hook)
 * rather than another instruction line; recurring searches point at a memory entry.
 */
export function suggest(current: Signals, history: Signals[]): string[] {
  const out: string[] = []
  const all = [current, ...history]
  const kindTotals: Record<string, { n: number; runs: number }> = {}
  for (const s of all)
    for (const [k, n] of Object.entries(s.enforcement.failureKinds)) {
      const t = (kindTotals[k] ??= { n: 0, runs: 0 })
      t.n += n
      t.runs++
    }
  for (const k of Object.keys(current.enforcement.failureKinds)) {
    const t = kindTotals[k]
    if (t.runs >= 2 || t.n >= 3) {
      const where = k.startsWith('TS') ? 'a stricter type at the source' : k.startsWith('eslint:') ? 'eslint --fix in the gate' : 'a test fixture or contract check'
      out.push(`gate: ${k} failed ${t.n}× across ${t.runs} run(s) → push down to ${where}`)
    }
  }
  if (current.enforcement.proseFixes.length && !current.enforcement.gateFixes.length && current.rework.checkFailures)
    out.push(`gate: this run fixed failures with prose (${current.enforcement.proseFixes.join(', ')}) and no gate change`)

  const searchRuns = new Map<string, number>()
  for (const s of all) {
    const seenHere = new Set([...s.memory.repeatedSearches.map((r) => r.pattern)])
    for (const p of seenHere) searchRuns.set(p, (searchRuns.get(p) ?? 0) + 1)
  }
  for (const r of current.memory.repeatedSearches) {
    const runs = searchRuns.get(r.pattern) ?? 1
    if (runs >= 2 || r.count >= 3) out.push(`memory: "${r.pattern}" searched ${r.count}× here, in ${runs} run(s) → record where it lives`)
  }
  for (const r of current.memory.rereads) out.push(`memory: re-read ${r.file} ${r.reads}× without editing it`)
  for (const r of current.rework.rewrites) if (r.rewrites >= 2) out.push(`rework: rewrote its own text in ${r.file} ${r.rewrites}× in one run`)
  return out
}
