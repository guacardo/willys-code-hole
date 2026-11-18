// Offline ledger report: verifies a plan against a git range and analyzes a Claude Code
// transcript with the same code Code Hole runs live.
//   npm run ledger -- --repo <dir> --base <ref> [--head <ref>] [--plan plan.json] [--transcript t.jsonl] [--out report.md]
import { readFileSync, writeFileSync } from 'node:fs'
import type { Plan, Signals, Verification, WorkCounts } from '../src/shared/types'
import { analyze, suggest, type Call } from '../src/main/ledger/signals'
import { changesSince, inferCombines, verifyPlan, workCounts } from '../src/main/ledger/verify'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
const repo = args.get('repo')!
const base = args.get('base')!
const head = args.get('head')

type Line = { type?: string; message?: { content?: unknown; usage?: Record<string, number> } }

function readTranscript(path: string) {
  const calls: Call[] = []
  const byId = new Map<string, Call>()
  let contextPeak = 0
  let output = 0
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (!raw.trim()) continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    const u = line.message?.usage
    if (line.type === 'assistant' && u) {
      contextPeak = Math.max(contextPeak, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
      output += u.output_tokens ?? 0
    }
    const content = line.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === 'tool_use') {
        const c: Call = { id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }
        calls.push(c)
        byId.set(c.id, c)
      } else if (b.type === 'tool_result') {
        const c = byId.get(String(b.tool_use_id))
        if (!c) continue
        const r = b.content
        c.result = typeof r === 'string' ? r : Array.isArray(r) ? r.map((x: { text?: string }) => x.text ?? '').join('\n') : ''
        c.isError = b.is_error === true
      }
    }
  }
  return { calls, contextPeak, output }
}

const fmtWork = (w: WorkCounts) => `create ${w.create} · extend ${w.extend} · delete ${w.delete} · combine ${w.combine}`

function render(plan: Plan | null, v: Verification | null, work: WorkCounts, combines: { into: string; from: string[] }[], s: Signals | null, t: { contextPeak: number; output: number } | null, sugg: string[]) {
  const out: string[] = []
  out.push(`- repo: \`${repo}\``, `- range: \`${base.slice(0, 10)}..${head ?? 'working tree'}\``, `- work: ${fmtWork(work)}`)
  for (const c of combines) out.push(`  - combine (inferred): ${c.from.join(' + ')} → ${c.into}`)
  if (plan && v) {
    out.push('', `## Plan vs. execution`, '', `Goal: ${plan.goal}`, '')
    for (const c of v.items) {
      const item = plan.items.find((i) => i.id === c.id)!
      out.push(`- **[${c.status}]** \`${item.action}\` ${item.primitive}${c.reason ? ` — ${c.reason}` : ''}`)
      if (c.evidence.length) out.push(`  - evidence: ${c.evidence.slice(0, 6).join('; ')}${c.evidence.length > 6 ? ` (+${c.evidence.length - 6})` : ''}`)
    }
    out.push('', `### Unplanned changes (${v.drift.length} files)`, '')
    for (const d of v.drift) {
      const parts = [...d.added.map((x) => `+${x}`), ...d.removed.map((x) => `-${x}`), ...d.changed.map((x) => `~${x}`)]
      out.push(`- ${d.file}${parts.length ? `: ${parts.slice(0, 8).join(', ')}${parts.length > 8 ? ` (+${parts.length - 8})` : ''}` : ''}`)
    }
  }
  if (s && t) {
    const r = s.rework
    out.push(
      '',
      '## Signals',
      '',
      `- calls ${s.calls} · context peak ${t.contextPeak.toLocaleString()} tok · output ${t.output.toLocaleString()} tok`,
      `- rework: churn ${r.churn.map((c) => `${c.file.split('/').pop()}×${c.edits}`).join(', ') || 'none'} · reverts ${r.reverts} · check failures ${r.checkFailures} · fail→fix loops ${r.failFixLoops} · duplicate calls ${r.duplicateCalls} · denials ${r.denials}`,
      `- enforcement: failure kinds ${Object.entries(s.enforcement.failureKinds).map(([k, n]) => `${k}×${n}`).join(', ') || 'none'} · prose fixes ${s.enforcement.proseFixes.length} · gate fixes ${s.enforcement.gateFixes.length}`,
      `- memory: orientation ${s.memory.orientationCalls} calls / ${Math.round(s.memory.orientationChars / 4).toLocaleString()} tok before first edit · re-reads ${s.memory.rereads.length} · repeated searches ${s.memory.repeatedSearches.length}`,
    )
    if (sugg.length) out.push('', '## Suggestions', '', ...sugg.map((x) => `- ${x}`))
  }
  return out.join('\n')
}

const changes = await changesSince(repo, base, head)
const combines = await inferCombines(repo, base, head, changes)
const work = workCounts(changes, combines)
const plan = args.has('plan') ? (JSON.parse(readFileSync(args.get('plan')!, 'utf8')) as Plan) : null
const v = plan ? verifyPlan(plan, changes, combines) : null
const t = args.has('transcript') ? readTranscript(args.get('transcript')!) : null
const s = t ? analyze(t.calls) : null
const md = render(plan, v, work, combines, s, t, s ? suggest(s, []) : [])
if (args.has('out')) writeFileSync(args.get('out')!, md + '\n')
console.log(md)
