import { For, Show } from 'solid-js'
import type { WorkAction } from '../../shared/types'
import type { TabState } from './store'

const ACTIONS: WorkAction[] = ['create', 'extend', 'delete', 'combine']

/** The submitted plan as one pill per primitive: color is the action, outline is the status. */
export function PlanStrip(props: { tab: TabState }) {
  return (
    <Show when={props.tab.plan}>
      {(p) => (
        <div class="plan-strip" title={p().plan.goal}>
          <For each={p().plan.items}>
            {(item) => {
              const status = () => p().statuses[item.id] ?? 'pending'
              const check = () => props.tab.verification?.items.find((c) => c.id === item.id)
              return (
                <span
                  class={`pill ${item.action} ${status()}`}
                  title={[`${item.action} ${item.primitive} — ${status()}`, item.why, check()?.reason, ...(check()?.evidence ?? [])].filter(Boolean).join('\n')}
                >
                  <b>{item.action}</b> {item.primitive}
                </span>
              )
            }}
          </For>
          <For each={props.tab.verification?.drift ?? []}>
            {(d) => (
              <span class="pill drift" title={[...d.added.map((s) => `+${s}`), ...d.removed.map((s) => `-${s}`), ...d.changed.map((s) => `~${s}`)].join('\n') || 'file changed'}>
                <b>unplanned</b> {d.file.split('/').pop()}
              </span>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}

function Bars(props: { trend: NonNullable<TabState['ledger']>['trend'] }) {
  const max = () => Math.max(1, ...props.trend.map((t) => ACTIONS.reduce((n, a) => n + t.work[a], 0)))
  return (
    <div class="ledger-bars" role="img" aria-label="Work type per run">
      <For each={props.trend}>
        {(t) => (
          <div class="ledger-bar" title={`${new Date(t.at).toLocaleString()}\n${ACTIONS.map((a) => `${a} ${t.work[a]}`).join(' · ')}\nrework ${t.reworkScore}`}>
            <For each={ACTIONS}>{(a) => <div class={`seg ${a}`} style={{ height: `${(t.work[a] / max()) * 100}%` }} />}</For>
          </div>
        )}
      </For>
    </div>
  )
}

export function LedgerSection(props: { tab: TabState }) {
  const run = () => props.tab.ledger?.run
  return (
    <Show when={run() || props.tab.gates.length || props.tab.verification}>
      <div class="ctx ledger">
        <div class="ctx-head">
          <strong>Ledger</strong>
          <Show when={run()}>{(r) => <span class="muted">{ACTIONS.map((a) => `${a} ${r().work[a]}`).join(' · ')}</span>}</Show>
        </div>
        <Show when={run()?.pr}>
          {(url) => (
            <a class="ledger-pr" href={url()} onClick={(e) => (e.preventDefault(), void window.hole.openExternal(url()))}>
              {url().replace(/^https:\/\/github\.com\//, '')}
            </a>
          )}
        </Show>
        <Show when={props.tab.ledger?.trend.length}>
          <Bars trend={props.tab.ledger!.trend} />
          <div class="ledger-legend">
            <For each={ACTIONS}>{(a) => <span class={`key ${a}`}>{a}</span>}</For>
          </div>
        </Show>
        <Show when={props.tab.verification}>
          {(v) => (
            <>
              <h4>Plan vs. execution</h4>
              <ul class="ctx-list">
                <For each={v().items}>
                  {(c) => (
                    <li>
                      <span>{props.tab.plan?.plan.items.find((i) => i.id === c.id)?.primitive ?? c.id}</span>
                      <span class={`muted status-${c.status}`} title={c.reason}>{c.status}</span>
                    </li>
                  )}
                </For>
                <For each={v().drift}>
                  {(d) => (
                    <li>
                      <span class="mono">{d.file}</span>
                      <span class="muted status-partial">unplanned</span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={v().explanation}>
                <p class="ledger-why">{v().explanation}</p>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.tab.gates.length}>
          <h4>Gates</h4>
          <ul class="ctx-list">
            <For each={props.tab.gates}>
              {(g) => (
                <li title={g.output}>
                  <span class="mono">{g.command.length > 48 ? g.command.slice(0, 48) + '…' : g.command}</span>
                  <span class={g.ok ? 'status-done' : 'status-missing'}>{g.ok ? 'pass' : Object.keys(g.kinds).join(' ') || 'fail'}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={run()}>
          {(r) => (
            <>
              <h4>Signals</h4>
              <ul class="ctx-list">
                <li>
                  <span>Rework</span>
                  <span class="muted">
                    {r().signals.rework.churn.length} churn · {r().signals.rework.reverts} reverts · {r().signals.rework.checkFailures} check fails ·{' '}
                    {r().signals.rework.duplicateCalls} dupes · {r().signals.rework.denials} denials
                  </span>
                </li>
                <li>
                  <span>Enforcement</span>
                  <span class="muted">
                    {r().signals.enforcement.gateFixes.length} gate fixes · {r().signals.enforcement.proseFixes.length} prose fixes
                  </span>
                </li>
                <li>
                  <span>Memory</span>
                  <span class="muted">
                    {r().signals.memory.orientationCalls} orienting calls · {r().signals.memory.rereads.length} re-reads ·{' '}
                    {r().signals.memory.repeatedSearches.length} repeat searches
                  </span>
                </li>
                <Show when={r().contextPeak}>
                  <li>
                    <span>Context peak</span>
                    <span class="muted">{r().contextPeak!.toLocaleString()} tok</span>
                  </li>
                </Show>
              </ul>
              <Show when={r().suggestions.length}>
                <h4>Suggestions</h4>
                <ul class="ledger-suggestions">
                  <For each={r().suggestions}>{(s) => <li>{s}</li>}</For>
                </ul>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}
