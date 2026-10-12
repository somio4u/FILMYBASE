// Draft Dashboard: every draft of a project (and alternatives), their lineage, status and where each one stopped.
// Opening a project shows this first; "Continue" resumes the draft at its saved stage. Making a new draft COPIES the chosen one —
// the original (and any pictures, voices, video or timeline made for it) is never changed.

import { useCallback, useEffect, useRef, useState } from 'react'
import './Drafts.css'

async function call(url, method = 'GET', body) {
  try {
    const r = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } }
  }
}

export const OPEN_LAST_KEY = 'filmmaking-app:openLastDraft'
const STAGE_LABEL = { idea: 'Idea', synopsis: 'Synopsis', characters: 'Characters', characterArc: 'Character arc', structure: 'Structure', threeAct: 'Three-act structure', bitsheet: 'Beat sheet', plot: 'Plot', story: 'Story', screenplay: 'Screenplay' }
const STATUS_LABEL = { working: 'Working', pending_approval: 'Waiting for approval', approved: 'Approved', locked: 'Locked', archived: 'Archived' }
const when = (v) => (v ? new Date(v).toLocaleString() : '—')

function Compare({ a, b, backendUrl, onClose }) {
  const [data, setData] = useState(null)
  const [show, setShow] = useState('changes')
  useEffect(() => { call(`${backendUrl}/api/drafts/compare?a=${a.id}&b=${b.id}`).then((r) => setData(r.ok ? r.data : { error: r.data.error })) }, [a.id, b.id, backendUrl])
  if (!data) return <p className="dd-note">Comparing…</p>
  if (data.error) return <p className="dd-error" role="alert">{data.error}</p>
  const rows = data.rows.filter((r) => (show === 'all' ? true : r.status !== 'preserved'))
  return (
    <section className="dd-compare" aria-label="Draft comparison">
      <header><h3>{a.title} → {b.title}</h3><button type="button" className="dd-btn" onClick={onClose}>Close</button></header>
      <p className="dd-counts">
        <span className="chip preserved">{data.counts.preserved} preserved</span> <span className="chip modified">{data.counts.modified} modified</span>{' '}
        <span className="chip added">{data.counts.added} added</span> <span className="chip removed">{data.counts.removed} removed</span>
        <label className="dd-inline"><input type="checkbox" checked={show === 'all'} onChange={(e) => setShow(e.target.checked ? 'all' : 'changes')} /> show preserved too</label>
      </p>
      {rows.length === 0 && <p className="dd-note">These two drafts have identical content.</p>}
      <ul className="dd-diff">
        {rows.map((r) => (
          <li key={`${r.section}:${r.key}`} className={`dd-row ${r.status}`}>
            <strong>{r.label}</strong> <span className={`chip ${r.status}`}>{r.status}</span>
            {(r.before || r.after) && (
              <div className="dd-sides">
                <div><h5>{a.title}</h5><pre>{r.before ?? '—'}</pre></div>
                <div><h5>{b.title}</h5><pre>{r.after ?? '—'}</pre></div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function DraftDashboard({ module, projectRef, backendUrl, onContinue, onClose, onChanged, onReviewRequest, onOpenDirect }) {
  const api = `${backendUrl}/api/drafts`
  const [dash, setDash] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState('')
  const [picked, setPicked] = useState([])
  const [compare, setCompare] = useState(null)
  const lock = useRef(false) // a double-click must not run an action twice
  const [openLast, setOpenLast] = useState(() => { try { return localStorage.getItem(OPEN_LAST_KEY) === '1' } catch { return false } })

  const load = useCallback(async () => {
    const r = await call(`${api}?module=${module}&projectRef=${projectRef}`)
    if (r.ok) setDash(r.data)
    else setError(r.data.error ?? (r.status ? `The server did not answer the drafts request properly (status ${r.status}). The backend may still be updating — try again in a minute.` : 'Could not reach the server.'))
  }, [api, module, projectRef])
  useEffect(() => { load() }, [load])

  async function act(label, fn, after) {
    if (busy || lock.current) return
    lock.current = true
    setBusy(label); setError(null)
    const r = await fn()
    lock.current = false
    setBusy('')
    if (!r.ok) { setError(r.data.error ?? 'That did not work.'); return }
    await load(); onChanged?.()
    after?.(r.data)
  }
  const branch = (d, kind) => {
    const name = window.prompt(kind === 'alternative' ? 'Name this alternative (for example "Villain survives"):' : `Name the new draft (optional). It will be a copy of ${d.title}; ${d.title} stays exactly as it is.`, '')
    if (name === null) return
    act('branch', () => call(`${api}/${d.id}/branch`, 'POST', { kind, label: name.trim() || null }))
  }
  const togglePick = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)))
  const byId = new Map((dash?.drafts ?? []).map((d) => [d.id, d]))
  const visible = (dash?.drafts ?? []).filter((d) => d.status !== 'archived')
  const archived = (dash?.drafts ?? []).filter((d) => d.status === 'archived')

  if (!dash) {
    return (
      <div className="dd-overlay">
        <div className="dd">
          {error ? <p className="dd-error" role="alert">{error}</p> : <p className="dd-note">Loading drafts…</p>}
          <div className="dd-actions">
            {error && <button type="button" className="dd-btn primary" onClick={() => onOpenDirect?.({ module, projectRef })}>Open the project anyway (without drafts)</button>}
            {error && <button type="button" className="dd-btn" onClick={load}>Try again</button>}
            <button type="button" className="dd-btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  const cleanup = async () => {
    const preview = await call(`${api}/cleanup-duplicates`, 'POST', { module, projectRef, dryRun: true, keep: 'none' })
    if (!preview.ok) { setError(preview.data?.error ?? 'Could not check for duplicates.'); return }
    const names = (preview.data.removed ?? []).map((x) => x.title ?? 'a draft being made').join(', ')
    if (!window.confirm(`Delete these unfinished duplicate copies: ${names || 'none'}?\n\nYour original draft and any draft you made yourself are kept.`)) return
    await act('cleanup', () => call(`${api}/cleanup-duplicates`, 'POST', { module, projectRef, keep: 'none' }))
  }

  const Card = ({ d }) => {
    const parent = d.parentDraftId ? byId.get(d.parentDraftId) : null
    return (
      <li className={`dd-card${d.id === dash.activeDraftId ? ' last' : ''}${d.kind === 'alternative' ? ' alt' : ''}`} data-draft-id={d.id}>
        <header>
          <label className="dd-pick"><input type="checkbox" checked={picked.includes(d.id)} onChange={() => togglePick(d.id)} aria-label={`Select ${d.title} to compare`} /></label>
          <h3>{d.title}{d.kind === 'alternative' ? ' (alternative)' : ''}</h3>
          <span className={`chip status-${d.status}`}>{STATUS_LABEL[d.status]}</span>
          {d.id === dash.activeDraftId && <span className="chip last">last used</span>}
        </header>
        <dl>
          <div><dt>From</dt><dd>{parent ? parent.title : 'The original'}</dd></div>
          <div><dt>Stage</dt><dd>{STAGE_LABEL[d.currentStage] ?? d.currentStage ?? '—'}{d.screenplayApproved ? ' · screenplay approved' : ''}</dd></div>
          <div><dt>Edited</dt><dd>{when(d.updatedAt)}</dd></div>
        </dl>
        {d.projectTitle && <p className="dd-fine">{d.projectTitle}</p>}
        {d.openRequest && !(dash.revisions ?? []).some((q) => q.id === d.openRequest.id) && <p className="dd-flag">Revision in progress: {d.openRequest.status.replace(/_/g, ' ')} <button type="button" className="dd-btn" onClick={() => onReviewRequest?.(d)}>Review revision</button></p>}
        {d.note && <p className="dd-fine">{d.note}</p>}
        <div className="dd-actions">
          <button type="button" className="dd-btn primary" onClick={() => onContinue(d)}>Continue Draft</button>
          <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={() => branch(d, 'numbered')}>Create Draft from This</button>
          <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={() => branch(d, 'alternative')}>Explore Alternative</button>
          {d.kind === 'alternative' && <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={() => act('promote', () => call(`${api}/${d.id}/promote`, 'POST', {}))}>Promote to Draft</button>}
          {d.status === 'locked'
            ? <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={() => act('unlock', () => call(`${api}/${d.id}`, 'PATCH', { status: 'working' }))}>Unlock</button>
            : <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={() => act('lock', () => call(`${api}/${d.id}`, 'PATCH', { status: 'locked' }))}>Lock</button>}
          {d.status !== 'archived'
            ? <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Archive ${d.title}? It is hidden from this list but nothing is deleted.`)) act('archive', () => call(`${api}/${d.id}`, 'PATCH', { status: 'archived', confirm: true })) }}>Archive</button>
            : <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={() => act('unarchive', () => call(`${api}/${d.id}`, 'PATCH', { status: 'working' }))}>Restore</button>}
        </div>
      </li>
    )
  }

  return (
    <div className="dd-overlay" role="dialog" aria-modal="true" aria-label="Draft Dashboard">
      <div className="dd">
        <header className="dd-head">
          <div><h2>Drafts</h2><p className="dd-note">Each draft is its own copy: making a new one never changes an older one, or the pictures and video made for it.</p></div>
          <button type="button" className="dd-btn" onClick={onClose}>Close</button>
        </header>
        {error && <p className="dd-error" role="alert">{error}</p>}
        <label className="dd-inline"><input type="checkbox" checked={openLast} onChange={(e) => { setOpenLast(e.target.checked); try { localStorage.setItem(OPEN_LAST_KEY, e.target.checked ? '1' : '0') } catch { /* per-browser convenience */ } }} /> Open the last-used draft directly next time (the Drafts button always brings this back)</label>
        {picked.length === 2 && <p><button type="button" className="dd-btn primary" onClick={() => setCompare(picked.map((id) => byId.get(id)))}>Compare {byId.get(picked[0])?.title} with {byId.get(picked[1])?.title}</button></p>}
        {picked.length < 2 && visible.length > 1 && <p className="dd-fine">Tick two drafts to compare them.</p>}
        {compare && <Compare a={compare[0]} b={compare[1]} backendUrl={backendUrl} onClose={() => setCompare(null)} />}
        {(dash.revisions ?? []).length === 1 && (() => { const q = dash.revisions[0]; return <p className="dd-flag" data-request-id={q.id}>A new draft is being made (it will be saved in this list when finished): “{String(q.instruction).slice(0, 90)}” — {q.status.replace(/_/g, ' ')} <button type="button" className="dd-btn" onClick={() => onReviewRequest?.({ openRequest: q })}>Review revision</button></p> })()}
        {(dash.revisions ?? []).length > 1 && (
          <p className="dd-flag" data-testid="dup-warning">There are {dash.revisions.length} unfinished “new draft” copies here — probably duplicates. <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={cleanup}>Delete the duplicates</button></p>
        )}
        <ul className="dd-cards">{visible.map((d) => <Card key={d.id} d={d} />)}</ul>
        {archived.length > 0 && <details className="dd-archived"><summary>Archived ({archived.length})</summary><ul className="dd-cards">{archived.map((d) => <Card key={d.id} d={d} />)}</ul></details>}
      </div>
    </div>
  )
}
