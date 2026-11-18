import type { GateResult, ItemStatus, LedgerRun, Plan, TabEvent, Usage, Verification } from '../../shared/types'
import { loadConfig } from '../config'
import { gateCommands, runGate } from './gate'
import { analyze, suggest, type Call } from './signals'
import { appendRun, readRuns, trendOf } from './store'
import { changesSince, inferCombines, isRepo, snapshot, verifyPlan, workCounts } from './verify'

const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_GATE_BLOCKS = 2

/**
 * One tab's measurement state for the current turn: tool calls, the submitted plan,
 * gate runs, and the working-tree snapshot both the plan and the turn are diffed against.
 */
export class Tracker {
  private calls: Call[] = []
  private byId = new Map<string, Call>()
  private plan: Plan | null = null
  private planBase: { ref: string; untracked: string[] } | null = null
  private statuses: Record<string, ItemStatus> = {}
  private turnBase: { ref: string; untracked: string[] } | null = null
  private gates: GateResult[] = []
  private gateBlocks = 0
  private asked = false
  private explanation: string | undefined
  private verification: Verification | undefined
  private contextPeak = 0
  private repo: string | null = null

  constructor(
    private root: () => Promise<string | null>,
    private emit: (e: TabEvent) => void,
  ) {}

  async turnStart() {
    this.calls = []
    this.byId.clear()
    this.gates = []
    this.gateBlocks = 0
    this.contextPeak = 0
    const root = await this.root()
    this.repo = root && (await isRepo(root)) ? root : null
    this.turnBase = this.repo ? await snapshot(this.repo).catch(() => null) : null
  }

  context(tokens: number) {
    this.contextPeak = Math.max(this.contextPeak, tokens)
  }

  toolUse(id: string, name: string, input: Record<string, unknown>) {
    const call: Call = { id, name, input }
    this.calls.push(call)
    this.byId.set(id, call)
    if (!this.plan || !EDIT.has(name)) return
    const file = String(input.file_path ?? input.notebook_path ?? '')
    let changed = false
    for (const item of this.plan.items) {
      if (this.statuses[item.id] === 'pending' && item.files.some((f) => file.endsWith(f.replace(/^\.\//, '')))) {
        this.statuses[item.id] = 'touched'
        changed = true
      }
    }
    if (changed) this.emit({ type: 'plan', plan: this.plan, statuses: { ...this.statuses } })
  }

  toolResult(id: string, content: string, isError: boolean) {
    const call = this.byId.get(id)
    if (!call) return
    call.result = content
    call.isError = isError
  }

  async submitPlan(plan: Plan): Promise<string> {
    this.plan = plan
    this.statuses = Object.fromEntries(plan.items.map((i) => [i.id, 'pending' as ItemStatus]))
    this.asked = false
    this.explanation = undefined
    this.verification = undefined
    const root = await this.root()
    this.planBase = root && (await isRepo(root)) ? await snapshot(root).catch(() => null) : null
    this.emit({ type: 'plan', plan, statuses: { ...this.statuses } })
    return `Plan recorded (${plan.items.length} items). The diff will be checked against it when you finish.`
  }

  private edited(): string[] {
    return [...new Set(this.calls.filter((c) => EDIT.has(c.name)).map((c) => String(c.input.file_path ?? c.input.notebook_path ?? '')))]
  }

  /** Stop hook: gates first, then plan verification. Returns a reason to keep the agent working, or null to let it stop. */
  async onStop(lastMessage: string | undefined): Promise<string | null> {
    if (this.asked && !this.explanation && lastMessage) {
      this.explanation = lastMessage
      if (this.verification) {
        this.verification.explanation = lastMessage
        this.emit({ type: 'verification', verification: this.verification })
      }
      return null
    }
    const repo = this.repo
    if (!repo) return null
    const edited = this.edited()
    if (edited.length && this.gateBlocks < MAX_GATE_BLOCKS) {
      const results = await Promise.all(gateCommands(repo, edited, loadConfig().projects?.[repo]?.gateCommand).map((c) => runGate(repo, c)))
      for (const r of results) {
        this.gates.push(r)
        this.emit({ type: 'gate', result: r })
      }
      const failing = results.filter((r) => !r.ok)
      if (failing.length) {
        this.gateBlocks++
        return `Code Hole gate failed. Fix these before finishing:\n\n${failing.map((r) => `$ ${r.command}\n${r.output.slice(-3000)}`).join('\n\n')}`
      }
    }
    if (this.plan && this.planBase && !this.asked) {
      const changes = await changesSince(repo, this.planBase.ref, undefined, this.planBase.untracked)
      const combines = await inferCombines(repo, this.planBase.ref, undefined, changes)
      const v = verifyPlan(this.plan, changes, combines)
      this.verification = v
      for (const c of v.items) this.statuses[c.id] = c.status
      this.emit({ type: 'plan', plan: this.plan, statuses: { ...this.statuses } })
      this.emit({ type: 'verification', verification: v })
      const gaps = v.items.filter((c) => c.status !== 'done')
      const drift = v.drift
      if (gaps.length || drift.length) {
        this.asked = true
        const lines = [
          ...gaps.map((g) => `- plan ${g.id} is ${g.status}${g.reason ? `: ${g.reason}` : ''}`),
          ...drift.map((d) => `- unplanned change in ${d.file}${[...d.added.map((s) => ` +${s}`), ...d.removed.map((s) => ` -${s}`), ...d.changed.map((s) => ` ~${s}`)].join(',')}`),
        ]
        return `Code Hole compared your diff to your plan. Reply with one line per deviation explaining why (no further edits unless one is a mistake):\n${lines.join('\n')}`
      }
    }
    return null
  }

  async turnDone(sessionId: string | undefined, usage: Usage) {
    const repo = this.repo
    if (!repo) return
    let work = { create: 0, extend: 0, delete: 0, combine: 0 }
    if (this.turnBase) {
      const changes = await changesSince(repo, this.turnBase.ref, undefined, this.turnBase.untracked).catch(() => [])
      const combines = await inferCombines(repo, this.turnBase.ref, undefined, changes).catch(() => [])
      work = workCounts(changes, combines)
    }
    const history = readRuns(repo)
    const signals = analyze(this.calls, this.gates)
    const run: LedgerRun = {
      at: new Date().toISOString(),
      repo,
      sessionId,
      usage,
      contextPeak: this.contextPeak || undefined,
      work,
      signals,
      plan: this.verification ? (this.plan ?? undefined) : undefined,
      verification: this.verification,
      gates: this.gates.map((g) => ({ ...g, output: g.ok ? '' : g.output.slice(-1500) })),
      suggestions: suggest(signals, history.map((r) => r.signals)),
    }
    if (!this.calls.length) return
    appendRun(run)
    this.emit({ type: 'ledger', run, trend: trendOf([...history, run]) })
    if (this.verification) {
      this.plan = null
      this.planBase = null
      this.verification = undefined
    }
  }
}
