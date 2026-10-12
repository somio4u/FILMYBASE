// AI Shot Optimization — a section of the Production Blueprint's Shots tab. It is part of the existing Shot Cutter: it reads the
// current shots, proposes which neighbouring shots could be one continuous shot and how many video requests that really needs,
// shows the before and after, and changes NOTHING until you press "Approve Optimized Shot Plan". It never starts paid pictures or video.

import { useCallback, useEffect, useState } from 'react'
import { useLive } from './useLive.js'
import './Production.css'

async function call(url, method = 'GET', body) {
  try {
    const response = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, data }
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } }
  }
}
const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const REASON = { near_duplicate: 'Near-identical shots', continuous_motion: 'One continuous movement', short_shot: 'Too short for its own request', reaction_repeat: 'Repeated reaction', repeated_establishing: 'Repeated establishing view', shot_reverse: 'Shot / reverse-shot exchange' }

function Stat({ label, value, sub }) {
  return <div className="so-stat"><dt>{label}</dt><dd>{value}</dd>{sub && <small>{sub}</small>}</div>
}

export default function ShotOptimization({ projectId, backendUrl, onChanged }) {
  const api = `${backendUrl}/api/production/${projectId}`
  const [data, setData] = useState(null)
  const [units, setUnits] = useState([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState(null)
  const [open, setOpen] = useState(null)

  const load = useCallback(async () => {
    const r = await call(`${api}/shot-plans`)
    if (r.ok) setData(r.data)
    const u = await call(`${api}/generation-units`)
    if (u.ok) setUnits(u.data.units)
  }, [api])
  useEffect(() => { load() }, [load])
  useLive(projectId, backendUrl, load)

  async function run(label, fn, okText) {
    if (busy) return
    setBusy(label)
    setMessage(null)
    const r = await fn()
    setBusy('')
    if (r.ok) { setMessage({ ok: true, text: okText ?? 'Done.' }); await load(); onChanged?.() }
    else setMessage({ ok: false, text: r.data?.error ?? 'That did not work.' })
  }

  if (!data) return <p className="dossier-note">Loading shot optimization…</p>
  const cur = data.current
  const plan = cur?.plan
  const draft = cur?.status === 'draft'
  const approved = cur?.status === 'approved'
  const mode = cur?.mode ?? 'balanced'
  const base = new Map((cur?.baseline ?? []).map((s) => [s.id, s]))
  const cmp = plan?.comparison

  return (
    <section className="so" aria-label="AI Shot Optimization">
      <header className="so-head">
        <h3>AI Shot Optimization</h3>
        <p className="dossier-fine-print">Every shot should earn its place, and every video request costs money. This looks for shots that can be one continuous shot, and shows exactly what would change. <strong>Nothing changes, and nothing paid starts, until you approve.</strong></p>
      </header>

      <fieldset className="so-modes" disabled={Boolean(busy) || approved}>
        <legend>Planning priority</legend>
        {data.modes.map((m) => (
          <label key={m.key} className={mode === m.key ? 'so-mode on' : 'so-mode'}>
            <input type="radio" name="so-mode" checked={mode === m.key} onChange={() => (draft ? run('mode', () => call(`${api}/shot-plans/${cur.id}`, 'PATCH', { mode: m.key }), `Now planning for ${m.label}.`) : run('analyze', () => call(`${api}/shot-plans`, 'POST', { mode: m.key }), 'Plan ready — review it below.'))} />
            <strong>{m.label}{m.key === 'balanced' ? ' (default)' : ''}</strong>
            <span>{m.blurb}</span>
          </label>
        ))}
      </fieldset>

      {!plan && (
        <div className="so-empty">
          <p className="dossier-note">No shot plan yet. Analyze the current shots to see how many could be merged and what that saves.</p>
          <button type="button" className="dossier-small-button" disabled={Boolean(busy)} onClick={() => run('analyze', () => call(`${api}/shot-plans`, 'POST', { mode: 'balanced' }), 'Plan ready — review it below.')}>{busy === 'analyze' ? 'Analyzing…' : 'Analyze shot plan'}</button>
        </div>
      )}

      {plan && (
        <>
          {cur.stale && <p className="dossier-error" role="alert">The shots changed after this plan was made. Analyze again before approving.</p>}
          <p className="so-status" role="status">
            Plan v{cur.version} — {draft ? 'draft (nothing applied yet)' : approved ? 'APPROVED and applied' : cur.status}
            {plan.auto_review_triggered && <strong className="so-dense"> · unusually dense: automatic review triggered</strong>}
          </p>
          <dl className="so-stats">
            <Stat label="Film length" value={mmss(plan.film_duration_seconds)} />
            <Stat label="Film type" value={plan.genre_label} sub={`usually ${plan.genre_range.min}–${plan.genre_range.max} shots (a guide, not a limit)`} />
            <Stat label="Original shots" value={plan.initial_editorial_shot_count} />
            <Stat label="Optimized shots" value={plan.optimized_editorial_shot_count} sub={`${cmp.shots_removed} fewer`} />
            <Stat label="Video requests" value={`${plan.initial_generation_unit_count} → ${plan.planned_generation_unit_count}`} />
            <Stat label="Video seconds billed" value={`${cmp.cinematic.requestedSeconds} → ${cmp.optimized.requestedSeconds}`} sub="Veo bills 4 / 6 / 8 s clips" />
            <Stat label="Estimated cost (with retries)" value={`${usd(cmp.cinematic.withRetriesUsd)} → ${usd(cmp.optimized.withRetriesUsd)}`} sub={cmp.prices_provisional ? 'provisional — built-in price estimates' : 'from configured prices'} />
            <Stat label="Estimated savings" value={`${usd(cmp.savings_usd)} (${cmp.savings_percent}%)`} />
            <Stat label="Confidence" value={`${Math.round(plan.optimization_confidence * 100)}%`} />
          </dl>
          <p className="so-reco"><strong>Recommended: {cmp.recommended === 'optimized' ? 'the optimized plan' : 'keep the original (cinematic) plan'}.</strong> {cmp.recommendation}</p>
          {plan.warnings.length > 0 && (
            <ul className="so-warnings" aria-label="Warnings">
              {plan.warnings.map((w, i) => <li key={i} className={`lvl-${w.level}`}>{w.level === 'error' ? '✖' : w.level === 'warning' ? '⚠' : 'ℹ'} {w.message}</li>)}
            </ul>
          )}
          {plan.review && <p className="dossier-fine-print">AI review: {plan.review.rejected?.length ?? 0} merge(s) rejected{plan.review.notes?.length ? ` · ${plan.review.notes.join(' · ')}` : ''}</p>}

          <h4>Before and after ({plan.groups.length} proposed {plan.groups.length === 1 ? 'merge' : 'merges'})</h4>
          {plan.groups.length === 0 && <p className="dossier-note">Nothing in this screenplay could be safely merged. Every shot has its own job.</p>}
          <ul className="so-groups">
            {plan.groups.map((g) => {
              const merged = plan.editorial_shots.find((e) => e.id === g.shotIds[0])
              const isOpen = open === g.id
              return (
                <li key={g.id} className={g.accepted ? 'so-group on' : 'so-group off'}>
                  <div className="so-group-row">
                    <label>
                      <input type="checkbox" checked={g.accepted} disabled={!draft || Boolean(busy)} onChange={(e) => run('toggle', () => call(`${api}/shot-plans/${cur.id}`, 'PATCH', { decisions: { [g.id]: e.target.checked } }), e.target.checked ? 'Merge switched on.' : 'Kept as separate shots.')} />
                      {' '}<strong>{g.codes.join(' + ')}</strong> <span className="so-reason">{g.reasons.map((r) => REASON[r] ?? r).join(', ')}</span>
                    </label>
                    <button type="button" className="dossier-small-button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : g.id)}>{isOpen ? 'Hide' : 'Show shots'}</button>
                  </div>
                  <p className="dossier-fine-print">{g.detail}</p>
                  {isOpen && (
                    <div className="so-compare">
                      <div>
                        <h5>Before ({g.shotIds.length} shots)</h5>
                        <ol>{g.shotIds.map((id) => <li key={id}><code>{base.get(id)?.code}</code> {base.get(id)?.framing} · {base.get(id)?.durationSec}s — {base.get(id)?.description}</li>)}</ol>
                      </div>
                      <div>
                        <h5>After (1 {g.action === 'remove' ? 'shot, duplicate dropped' : 'continuous shot'}, {Math.round(g.durationSec)}s)</h5>
                        <p>{g.accepted ? merged?.description : 'Not merged — the shots above stay separate.'}</p>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          <details className="so-scenes">
            <summary>Scene by scene</summary>
            <table className="so-table"><thead><tr><th>Scene</th><th>Before</th><th>After</th><th>Video requests</th></tr></thead>
              <tbody>{plan.scene_breakdown.map((s) => <tr key={s.scene_id}><td>{s.scene_code}</td><td>{s.initial_shots}</td><td>{s.optimized_shots}</td><td>{s.generation_units}</td></tr>)}</tbody></table>
          </details>

          <div className="so-actions">
            {draft && <button type="button" className="dossier-small-button" disabled={Boolean(busy)} onClick={() => run('review', () => call(`${api}/shot-plans/${cur.id}/review`, 'POST'), 'The AI reviewed the merges.')}>{busy === 'review' ? 'Reviewing…' : 'Ask AI to review the merges'}</button>}
            {draft && <button type="button" className="dossier-small-button primary" disabled={Boolean(busy) || cur.stale || plan.warnings.some((w) => w.level === 'error')} onClick={() => run('approve', () => call(`${api}/shot-plans/${cur.id}/approve`, 'POST'), 'Optimized shot plan approved. Prompts were planned; nothing paid was started.')}>{busy === 'approve' ? 'Applying…' : 'Approve Optimized Shot Plan'}</button>}
            {approved && <button type="button" className="dossier-small-button" disabled={Boolean(busy)} onClick={() => run('restore', () => call(`${api}/shot-plans/${cur.id}/restore`, 'POST'), 'Original shots restored.')}>Restore the original shots</button>}
            <button type="button" className="dossier-small-button" disabled={Boolean(busy)} onClick={() => run('analyze', () => call(`${api}/shot-plans`, 'POST', { mode }), 'Analyzed again.')}>Analyze again</button>
          </div>
          <p className="dossier-fine-print">Approving only rewrites shots and prompts. Making pictures and video is still separate, one button at a time, in the Image and Video Studios.</p>
        </>
      )}

      {units.some((u) => u.shotIds.length > 1) && (
        <div className="so-units">
          <h4>Combined generation units</h4>
          <p className="dossier-fine-print">These units make ONE video for several shots; their clips read different parts of it. If a combined video fails, split it into simple units — nothing else is rebuilt.</p>
          <ul>{units.filter((u) => u.shotIds.length > 1).map((u) => <li key={u.id}><strong>{u.code}</strong> · {u.shotIds.length} shots · {u.requestedSeconds}s <button type="button" className="dossier-small-button" disabled={Boolean(busy)} onClick={() => run('split', () => call(`${api}/generation-units/${u.id}/split`, 'POST'), 'Split into separate shots.')}>Split</button></li>)}</ul>
        </div>
      )}
      {message && <p className={message.ok ? 'dossier-note' : 'dossier-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
    </section>
  )
}
