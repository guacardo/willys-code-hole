import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Drift, ItemCheck, Plan, PlanItem, Verification, WorkCounts } from '../../shared/types'
import { diffSymbols, symbolMatches, symbolsOf } from './symbols'

const run = promisify(execFile)

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

export async function isRepo(dir: string): Promise<boolean> {
  return git(dir, ['rev-parse', '--is-inside-work-tree']).then(
    (s) => s.trim() === 'true',
    () => false,
  )
}

/** A commit capturing the working tree right now (tracked files), without touching it. */
export async function snapshot(repo: string): Promise<{ ref: string; untracked: string[] }> {
  const stash = (await git(repo, ['stash', 'create']).catch(() => '')).trim()
  const ref = stash || (await git(repo, ['rev-parse', 'HEAD'])).trim()
  return { ref, untracked: await untracked(repo) }
}

async function untracked(repo: string): Promise<string[]> {
  return (await git(repo, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)
}

export type FileChange = { file: string; added: string[]; removed: string[]; changed: string[]; created: boolean; deleted: boolean }

/** Symbol-level changes from `base` to `head` (a ref, or the working tree when omitted). */
export async function changesSince(repo: string, base: string, head?: string, baseUntracked: string[] = []): Promise<FileChange[]> {
  const status = await git(repo, ['diff', '--name-status', '--no-renames', base, ...(head ? [head] : [])])
  const entries = status
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [s, file] = l.split('\t')
      return { s: s[0], file }
    })
  if (!head) {
    const known = new Set(baseUntracked)
    for (const file of await untracked(repo)) if (!known.has(file)) entries.push({ s: 'A', file })
  }
  const show = (ref: string, file: string) => git(repo, ['show', `${ref}:${file}`]).catch(() => '')
  const read = (file: string) => (head ? show(head, file) : readFile(join(repo, file), 'utf8').catch(() => ''))
  return Promise.all(
    entries.map(async ({ s, file }) => {
      const before = s === 'A' ? '' : await show(base, file)
      const after = s === 'D' ? '' : await read(file)
      return { file, created: s === 'A', deleted: s === 'D', ...diffSymbols(symbolsOf(file, before), symbolsOf(file, after)) }
    }),
  )
}

/** Combines the diff can show: two or more removed symbols whose former callers now call one created symbol. */
export async function inferCombines(repo: string, base: string, head: string | undefined, changes: FileChange[]) {
  const removed = changes.flatMap((c) => c.removed.filter((k) => !k.includes('.')).map((k) => ({ k, file: c.file })))
  const created = changes.flatMap((c) => c.added.filter((k) => !k.includes('.')).map((k) => ({ k, file: c.file })))
  if (removed.length < 2 || !created.length || removed.length > 60) return []
  const grep = async (ref: string | undefined, word: string) =>
    new Set(
      (await git(repo, ['grep', ...(ref ? [] : ['--untracked']), '-l', '-w', word, ...(ref ? [ref] : []), '--']).catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => (ref ? l.slice(ref.length + 1) : l)),
    )
  const before = new Map<string, Set<string>>()
  for (const r of removed) before.set(r.k, await grep(base, r.k).then((s) => (s.delete(r.file), s)))
  const out: { into: string; from: string[] }[] = []
  for (const c of created) {
    const now = await grep(head, c.k)
    now.delete(c.file)
    const from = removed.filter((r) => [...(before.get(r.k) ?? [])].some((f) => now.has(f))).map((r) => r.k)
    if (from.length >= 2) out.push({ into: c.k, from })
  }
  return out
}

export function workCounts(changes: FileChange[], combines: { into: string; from: string[] }[]): WorkCounts {
  const absorbed = new Set(combines.flatMap((c) => [c.into, ...c.from]))
  const count = (keys: string[]) => keys.filter((k) => !absorbed.has(k)).length
  return {
    create: changes.reduce((n, c) => n + count(c.added), 0),
    extend: changes.reduce((n, c) => n + count(c.changed), 0),
    delete: changes.reduce((n, c) => n + count(c.removed), 0),
    combine: combines.length,
  }
}

const norm = (f: string) => f.replace(/^\.\//, '')

function checkItem(item: PlanItem, changes: FileChange[], combines: { into: string; from: string[] }[]): { check: ItemCheck; claimed: Set<string> } {
  const claimed = new Set<string>()
  const files = item.files.map(norm)
  const inFiles = changes.filter((c) => files.some((f) => c.file === f || c.file.endsWith(`/${f}`) || f.endsWith(`/${c.file}`)))
  const pool = (kind: 'added' | 'removed' | 'changed') =>
    (inFiles.length ? inFiles : changes).flatMap((c) => c[kind].map((k) => ({ file: c.file, key: k })))
  const find = (s: string, kinds: ('added' | 'removed' | 'changed')[]) =>
    kinds.flatMap((k) => pool(k).filter((p) => symbolMatches(s, p.key)).map((p) => ({ ...p, kind: k })))

  const evidence: string[] = []
  const misses: string[] = []
  const want: Record<PlanItem['action'], ('added' | 'removed' | 'changed')[]> = {
    create: ['added'],
    extend: ['changed', 'added'],
    delete: ['removed'],
    combine: ['added', 'changed'],
  }
  for (const s of item.symbols) {
    const hits = find(s, want[item.action])
    if (hits.length) {
      for (const h of hits) {
        claimed.add(`${h.file}#${h.key}`)
        evidence.push(`${h.kind} ${h.key} (${h.file})`)
      }
    } else {
      const other = find(s, ['added', 'removed', 'changed'])
      misses.push(other.length ? `${s}: expected ${item.action}, saw ${other.map((o) => o.kind).join('/')}` : `${s}: no change`)
      for (const h of other) claimed.add(`${h.file}#${h.key}`)
    }
  }
  if (item.action === 'combine') {
    for (const raw of item.from ?? []) {
      const f = raw.replace(/^.*[:#]/, '')
      const gone = changes.flatMap((c) => c.removed.filter((k) => symbolMatches(f, k)).map((key) => ({ file: c.file, key })))
      const inferred = combines.some((c) => c.from.some((x) => symbolMatches(f, x)))
      if (gone.length || inferred) {
        evidence.push(`absorbed ${f}`)
        for (const h of gone) claimed.add(`${h.file}#${h.key}`)
      } else misses.push(`${raw}: still present`)
    }
  }
  for (const c of inFiles) for (const k of [...c.added, ...c.removed, ...c.changed]) claimed.add(`${c.file}#${k}`)
  for (const c of inFiles) claimed.add(`${c.file}#`)

  const touched = inFiles.length > 0
  const status: ItemCheck['status'] =
    misses.length === 0 && (evidence.length || touched) ? 'done' : evidence.length || touched ? 'partial' : 'missing'
  return { check: { id: item.id, status, evidence, reason: misses.length ? misses.join('; ') : undefined }, claimed }
}

export function verifyPlan(plan: Plan, changes: FileChange[], combines: { into: string; from: string[] }[]): Verification {
  const claimed = new Set<string>()
  const items = plan.items.map((item) => {
    const r = checkItem(item, changes, combines)
    for (const c of r.claimed) claimed.add(c)
    return r.check
  })
  const drift: Drift[] = []
  for (const c of changes) {
    if (claimed.has(`${c.file}#`)) continue
    const un = (keys: string[]) => keys.filter((k) => !claimed.has(`${c.file}#${k}`))
    const d = { file: c.file, added: un(c.added), removed: un(c.removed), changed: un(c.changed) }
    drift.push(d)
  }
  return { items, drift }
}
