import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GateResult, Plan, Signals, Usage, Verification, WorkCounts } from '../../shared/types'

const run = promisify(execFile)

async function sh(cwd: string, cmd: string, args: string[], input?: string): Promise<string> {
  const p = run(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  if (input !== undefined) {
    p.child.stdin?.write(input)
    p.child.stdin?.end()
  }
  return (await p).stdout.trim()
}

export async function defaultBranch(repo: string): Promise<string | null> {
  const ref = await sh(repo, 'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  return ref ? ref.replace(/^origin\//, '') : null
}

export const currentBranch = (repo: string) => sh(repo, 'git', ['branch', '--show-current']).catch(() => '')

export const slug = (goal: string) =>
  goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 5)
    .join('-') || 'plan'

/** Moves work off the default branch onto a feature branch named for the plan. Uncommitted changes come along. */
export async function ensureFeatureBranch(repo: string, plan: Plan): Promise<string | null> {
  const main = await defaultBranch(repo)
  const cur = await currentBranch(repo)
  if (!main || !cur || cur !== main) return null
  const existing = new Set((await sh(repo, 'git', ['branch', '--format=%(refname:short)'])).split('\n'))
  let name = slug(plan.goal)
  for (let i = 2; existing.has(name); i++) name = `${slug(plan.goal)}-${i}`
  await sh(repo, 'git', ['switch', '-c', name])
  return name
}

export function trailers(plan: Plan, v?: Verification): string {
  return plan.items
    .map((i) => `Plan-Item: ${i.id} ${i.action} ${i.primitive} (${v?.items.find((c) => c.id === i.id)?.status ?? 'unverified'})`)
    .join('\n')
}

/** Commits whatever the plan run left uncommitted, with one Plan-Item trailer per item; empty when the agent already committed. */
export async function ledgerCommit(repo: string, files: string[], plan: Plan, v: Verification | undefined, coAuthor: string) {
  if (files.length) await sh(repo, 'git', ['add', '-A', '--', ...files])
  const msg = `${plan.goal}\n\n${v?.explanation ? `${v.explanation.trim()}\n\n` : ''}${trailers(plan, v)}\n${coAuthor}`
  await sh(repo, 'git', ['commit', '--allow-empty', '-F', '-'], msg)
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const code = (s: string) => `\`${s.replace(/`/g, '')}\``

export function prBody(r: {
  plan: Plan
  verification?: Verification
  work: WorkCounts
  gates: GateResult[]
  signals?: Signals
  usage?: Usage
  contextPeak?: number
  extra?: string
}): string {
  const v = r.verification
  const out: string[] = [r.plan.goal, '', '## Plan vs. execution', '', '| Action | Primitive | Status | Evidence / gap |', '|---|---|---|---|']
  for (const i of r.plan.items) {
    const c = v?.items.find((x) => x.id === i.id)
    const ev = c ? [c.reason, c.evidence.slice(0, 4).join('; ') + (c.evidence.length > 4 ? ` (+${c.evidence.length - 4})` : '')].filter(Boolean).join(' — ') : ''
    out.push(`| ${i.action} | ${code(i.primitive)} | ${c?.status ?? 'unverified'} | ${cell(ev)} |`)
  }
  for (const d of v?.drift ?? []) {
    const parts = [...d.added.map((s) => `+${s}`), ...d.removed.map((s) => `-${s}`), ...d.changed.map((s) => `~${s}`)]
    out.push(`| unplanned | ${code(d.file)} | — | ${cell(parts.slice(0, 6).join(', '))} |`)
  }
  if (v?.explanation) out.push('', '### Why it deviated', '', v.explanation.trim())
  const w = r.work
  out.push('', '## Ledger', '', '| | |', '|---|---|', `| Work | create ${w.create} · extend ${w.extend} · delete ${w.delete} · combine ${w.combine} |`)
  for (const g of r.gates) out.push(`| Gate ${code(g.command.length > 60 ? g.command.slice(0, 60) + '…' : g.command)} | ${g.ok ? 'pass' : `fail ${Object.keys(g.kinds).join(' ')}`} |`)
  const s = r.signals
  if (s) {
    out.push(
      `| Rework | ${s.rework.churn.length} churned files · ${s.rework.reverts} reverts · ${s.rework.checkFailures} check failures (${s.rework.failFixLoops} fixed) · ${s.rework.duplicateCalls} duplicate calls · ${s.rework.denials} denials |`,
      `| Enforcement | ${Object.entries(s.enforcement.failureKinds).map(([k, n]) => `${k}×${n}`).join(', ') || 'no failure kinds'} · ${s.enforcement.gateFixes.length} gate fixes · ${s.enforcement.proseFixes.length} prose fixes |`,
      `| Memory | ${s.memory.orientationCalls} orienting calls (~${Math.round(s.memory.orientationChars / 4).toLocaleString()} tok) before first edit · ${s.memory.rereads.length} re-reads · ${s.memory.repeatedSearches.length} repeated searches |`,
    )
  }
  if (r.contextPeak) out.push(`| Context peak | ${r.contextPeak.toLocaleString()} tok |`)
  if (r.usage) out.push(`| Cost | $${r.usage.costUsd.toFixed(2)} · ${r.usage.turns} turns · ${Math.round(r.usage.durationMs / 1000)}s |`)
  if (r.extra) out.push('', r.extra)
  out.push('', '<details><summary>Ledger JSON</summary>', '', '```json', JSON.stringify({ plan: r.plan, verification: v, work: w, signals: s }, null, 1), '```', '</details>')
  return out.join('\n')
}

/** Pushes the current feature branch and opens its PR, or refreshes the body of the one already open. Never pushes the default branch. */
export async function publish(repo: string, title: string, body: string, branch?: string): Promise<string> {
  const main = await defaultBranch(repo)
  const head = branch ?? (await currentBranch(repo))
  if (!main || !head || head === main) throw new Error(`refusing to push ${head || 'detached HEAD'}: not a feature branch`)
  await sh(repo, 'git', ['push', '-u', 'origin', `${head}:${head}`])
  const open = await sh(repo, 'gh', ['pr', 'view', head, '--json', 'url,state', '-q', 'select(.state=="OPEN") | .url']).catch(() => '')
  if (open) {
    await sh(repo, 'gh', ['pr', 'edit', head, '--body-file', '-'], body)
    return open
  }
  return sh(repo, 'gh', ['pr', 'create', '--base', main, '--head', head, '--title', title, '--body-file', '-'], body)
}
