// Production Blueprint workspace: everything that is planned BEFORE any paid image / video / voice is made.
//   Overview   the checklist (screenplay -> shots -> prompts -> validation -> approval), the cost estimate, approve / reopen
//   Shots      cut scenes into shots and write the text storyboard (the existing Shot Cutter screens)
//   Prompts    the prompt library: model-sheet, first-frame, video and audio prompts, editable, with full version history
//   Assets     the Production Dossier (characters, environments, properties as planned specifications)
// Approving the Blueprint creates the Timeline placeholders immediately.

import ShotOptimization from './ShotOptimization.jsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import ProductionDossier from './ProductionDossier.jsx'
import PipelineStage from './PipelineStage.jsx'
import { useLive } from './useLive.js'
import './Pipeline.css'
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
const PURPOSES = [
  { key: 'model_sheet', label: 'Model sheets', hint: 'One per character, environment and property.' },
  { key: 'first_frame', label: 'First frames', hint: 'One per shot: the picture the shot starts from.' },
  { key: 'video', label: 'Video motion', hint: 'One per shot: how it moves, starting from the approved first frame.' },
  { key: 'audio', label: 'Audio', hint: 'One per spoken line: who says what, in which voice.' },
]

function Step({ n, title, state, children }) {
  return (
    <li className={`bp-step ${state}`}>
      <span className="bp-step-mark" aria-hidden="true">{state === 'done' ? '✓' : n}</span>
      <div>
        <strong>{title}</strong> <span className="bp-step-state">{state === 'done' ? '— done' : state === 'todo' ? '— to do' : state === 'blocked' ? '— waiting' : ''}</span>
        <div className="bp-step-body">{children}</div>
      </div>
    </li>
  )
}

function Overview({ api, projectId, bp, manifest, reload, onTab }) {
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState(null)
  const v = bp?.validation
  const approved = bp?.blueprint?.status === 'approved'
  async function run(label, url, body, okText) {
    setBusy(label); setMessage(null)
    const r = await call(url, 'POST', body ?? {})
    setBusy('')
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Something went wrong.', list: r.data.validation?.errors })
    else setMessage({ tone: 'good', text: typeof okText === 'function' ? okText(r.data) : okText })
    await reload()
  }
  if (!bp || !manifest) return <p className="dossier-note">Loading…</p>
  const t = manifest.totals
  const shotsOk = v && !v.errors.some((e) => ['no_shots', 'scene_without_shots', 'shots_not_approved'].includes(e.code))
  const promptsOk = v && !v.errors.some((e) => e.code.includes('prompts') || e.code === 'stale_prompts')
  return (
    <div className="pipe-panel bp-overview">
      <section className="bp-cards" aria-label="Where the plan stands">
        <div className="bp-card"><span>Screenplay</span><strong>version {bp.screenplayVersion ?? '—'}</strong><small>{t.scenes} scenes</small></div>
        <div className="bp-card"><span>Blueprint</span><strong>{bp.blueprint ? `v${bp.blueprint.version} · ${approved ? (bp.staleness.stale ? 'approved, out of date' : 'approved') : 'draft'}` : 'not started'}</strong><small>{t.shots} shots · {(t.planned_duration_ms / 1000 / 60).toFixed(1)} min planned</small></div>
        <div className="bp-card"><span>Prompts</span><strong>{v ? v.counts.prompts : 0} planned</strong><small>{v?.counts.missingPrompts ?? 0} missing · {v?.counts.stalePrompts ?? 0} out of date</small></div>
        <div className="bp-card"><span>Estimated cost to make everything</span><strong>{v ? usd(v.estimate.totalUsd) : '—'}</strong><small>{v ? `${usd(v.estimate.remainingBudgetUsd)} left of the limit` : ''}</small></div>
      </section>

      {approved && bp.staleness.stale && (
        <div className="bp-alert" role="alert">
          <strong>This approved Blueprint no longer matches the project.</strong>
          <ul>{bp.staleness.reasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul>
          <p>Nothing was deleted. Reopen the Blueprint, fix the plan, and approve it again — only what changed is re-planned.</p>
        </div>
      )}

      <ol className="bp-steps">
        <Step n={1} title="Approved screenplay read into production" state={t.scenes > 0 ? 'done' : 'todo'}>
          {t.scenes > 0 ? `${t.scenes} scenes, ${t.dialogue_lines} spoken lines.` : 'Approve the screenplay (Story & Screenplay) — it is read in automatically — or press Sync.'}
          <button type="button" className="dossier-small-button" disabled={busy === 'sync'} onClick={() => run('sync', `${api}/${projectId}/blueprint/sync`, {}, (d) => (d.analyzed ? `Read ${d.summary.scenes} scenes (screenplay version ${d.screenplayVersion}).` : d.reason))}>Sync from the screenplay</button>
        </Step>
        <Step n={2} title="Scenes cut into shots, with lengths, and approved" state={t.scenes === 0 ? 'blocked' : shotsOk ? 'done' : 'todo'}>
          {t.shots} shots planned. {v?.errors.filter((e) => ['no_shots', 'scene_without_shots', 'shots_not_approved'].includes(e.code)).map((e) => e.message).slice(0, 3).join(' ')}
          <button type="button" className="dossier-small-button" onClick={() => onTab('shots')}>Open the Shots tab</button>
        </Step>
        <Step n={3} title="Prompts planned for every model sheet, first frame, video and voice" state={t.shots === 0 ? 'blocked' : promptsOk ? 'done' : 'todo'}>
          Free — no AI is used. Prompts you edit are never overwritten; every version is kept.
          <button type="button" className="dossier-small-button" disabled={busy === 'plan' || t.shots === 0} onClick={() => run('plan', `${api}/${projectId}/blueprint/prompts/plan`, {}, (d) => `Prompts: ${d.created} new, ${d.updated} updated, ${d.unchanged} unchanged${d.kept_edited ? `, ${d.kept_edited} edited by you kept` : ''}.`)}>{busy === 'plan' ? 'Planning…' : 'Plan the prompts'}</button>
          <button type="button" className="dossier-small-button" onClick={() => onTab('prompts')}>Review them</button>
        </Step>
        <Step n={4} title="Checked: ids, lengths, prompts, dependencies, screenplay version" state={v?.ok ? 'done' : 'todo'}>
          {v && v.errors.length === 0 && <span className="bp-ok">No problems found.</span>}
          {v?.errors.length > 0 && <ul className="bp-list bad">{v.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>}
          {v?.warnings.length > 0 && <ul className="bp-list warn">{v.warnings.map((e, i) => <li key={i}>{e.message}</li>)}</ul>}
        </Step>
        <Step n={5} title="Blueprint approved — the Timeline is created at once" state={approved ? 'done' : v?.ok ? 'todo' : 'blocked'}>
          {approved ? 'The Timeline exists with one placeholder per shot. No images, videos or voices are needed for that.' : 'Approving creates one labelled placeholder per shot on the Timeline, sized by its planned length. Nothing is generated.'}
          {!approved && <button type="button" className="dossier-small-button bp-approve" disabled={!v?.ok || busy === 'approve'} onClick={() => run('approve', `${api}/${projectId}/blueprint/approve`, {}, (d) => `Blueprint approved. Timeline created: ${d.timeline.created} shot placeholders and ${d.timeline.dialogue} dialogue placeholders.`)}>{busy === 'approve' ? 'Approving…' : 'Approve the Blueprint'}</button>}
          {approved && <button type="button" className="dossier-small-button" disabled={busy === 'reopen'} onClick={() => run('reopen', `${api}/${projectId}/blueprint/reopen`, { reason: 'Reopened from the Blueprint screen' }, 'Reopened as a new draft. The Timeline, prompts and media are all kept.')}>Reopen for changes</button>}
        </Step>
      </ol>

      {v && (
        <section className="bp-estimate" aria-label="Cost estimate">
          <h3>What it would cost to make everything that is not yet approved</h3>
          <table className="bp-table">
            <tbody>
              <tr><td>Reference sheets ({v.estimate.references})</td><td>{usd(v.estimate.referencesUsd)}</td></tr>
              <tr><td>First frames ({v.estimate.frames})</td><td>{usd(v.estimate.framesUsd)}</td></tr>
              <tr><td>Video ({v.estimate.videoShots} shots, {v.estimate.videoSeconds} s)</td><td>{usd(v.estimate.videoUsd)}</td></tr>
              <tr><td>Voices ({v.estimate.audioChars} characters)</td><td>{usd(v.estimate.audioUsd)}</td></tr>
              <tr className="bp-total"><td>Total</td><td>{usd(v.estimate.totalUsd)}</td></tr>
            </tbody>
          </table>
          <p className="dossier-fine-print">{v.estimate.note}</p>
        </section>
      )}
      {message && (
        <div className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>
          {message.text}
          {message.list && <ul>{message.list.map((e, i) => <li key={i}>{e.message}</li>)}</ul>}
        </div>
      )}
    </div>
  )
}

export function PromptCard({ p, label, api, projectId, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(p.text)
  const [history, setHistory] = useState(null)
  const [message, setMessage] = useState(null)
  const target = p.assetId ? `assetId=${p.assetId}` : p.shotId ? `shotId=${p.shotId}` : `elementId=${p.elementId}`
  async function save() {
    const r = await call(`${api}/${projectId}/blueprint/prompts`, 'PUT', { purpose: p.purpose, assetId: p.assetId, shotId: p.shotId, elementId: p.elementId, text })
    if (!r.ok) { setMessage(r.data.error); return }
    setEditing(false); setHistory(null); setMessage(null); onSaved()
  }
  async function showHistory() {
    if (history) { setHistory(null); return }
    const r = await call(`${api}/${projectId}/blueprint/prompts/history?purpose=${p.purpose}&${target}`)
    setHistory(r.ok ? r.data.versions : [])
  }
  return (
    <li className={`bp-prompt ${p.stale ? 'stale' : ''}`}>
      <div className="bp-prompt-head">
        <strong>{label}</strong>
        <span className="dossier-fine-print">version {p.version}</span>
        {p.edited && <span className="dossier-badge edited">Edited by you</span>}
        {p.stale && <span className="dossier-badge stale" title="The shot, asset or film look changed after this was written.">Out of date</span>}
      </div>
      {editing
        ? <textarea className="bp-prompt-edit" value={text} rows={6} onChange={(e) => setText(e.target.value)} aria-label={`Prompt for ${label}`} />
        : <p className="bp-prompt-text">{p.text}</p>}
      <div className="pipe-card-buttons">
        {editing
          ? <><button type="button" className="dossier-small-button" onClick={save}>Save as a new version</button><button type="button" className="dossier-small-button" onClick={() => { setEditing(false); setText(p.text) }}>Cancel</button></>
          : <button type="button" className="dossier-small-button" onClick={() => { setText(p.text); setEditing(true) }}>Edit</button>}
        <button type="button" className="dossier-small-button" onClick={showHistory}>{history ? 'Hide history' : 'History'}</button>
      </div>
      {message && <p className="dossier-error">{message}</p>}
      {history && (
        <ol className="bp-history">
          {history.map((h) => <li key={h.id}><strong>v{h.version}</strong> {h.status === 'current' ? '(current)' : ''} {h.edited ? '· edited by a person' : '· planned'} <span className="dossier-fine-print">{new Date(h.created_at).toLocaleString()}</span><p>{h.text}</p></li>)}
        </ol>
      )}
    </li>
  )
}

function Prompts({ api, projectId, manifest }) {
  const [purpose, setPurpose] = useState('first_frame')
  const [data, setData] = useState(null)
  const [scene, setScene] = useState('')
  const [limit, setLimit] = useState(30)
  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/blueprint/prompts`)
    if (r.ok) setData(r.data)
  }, [api, projectId])
  useEffect(() => { load() }, [load])
  const labels = useMemo(() => {
    const map = new Map()
    for (const s of manifest?.shots ?? []) map.set(`s${s.db_id}`, { text: `${s.shot_id} — ${String(s.action).slice(0, 70)}`, scene: s.scene_id })
    for (const a of manifest?.assets ?? []) map.set(`a${a.db_id}`, { text: `${a.asset_id} ${a.name}`, scene: null })
    return map
  }, [manifest])
  if (!data) return <p className="dossier-note">Loading…</p>
  const list = data.prompts.filter((p) => p.purpose === purpose).map((p) => ({ p, label: labels.get(p.assetId ? `a${p.assetId}` : p.shotId ? `s${p.shotId}` : '')?.text ?? (p.elementId ? `Spoken line #${p.elementId}` : 'Prompt'), scene: labels.get(p.shotId ? `s${p.shotId}` : '')?.scene ?? null }))
  const scenes = [...new Set((manifest?.shots ?? []).map((s) => s.scene_id))]
  const shown = list.filter((x) => !scene || x.scene === scene || x.scene === null)
  return (
    <div className="pipe-panel">
      <nav className="dossier-tabs" aria-label="Prompt types">
        {PURPOSES.map((x) => <button key={x.key} type="button" className={purpose === x.key ? 'dossier-tab active' : 'dossier-tab'} onClick={() => { setPurpose(x.key); setLimit(30) }}>{x.label}<span className="dossier-tab-count"> {data.prompts.filter((p) => p.purpose === x.key).length}</span></button>)}
      </nav>
      <p className="dossier-fine-print">{PURPOSES.find((x) => x.key === purpose).hint} Edits make a new version; older versions stay in the history. {data.stale > 0 ? `${data.stale} prompt${data.stale === 1 ? ' is' : 's are'} out of date.` : ''} {data.missing > 0 ? `${data.missing} not planned yet — use “Plan the prompts” on the Overview.` : ''}</p>
      {(purpose === 'first_frame' || purpose === 'video') && scenes.length > 1 && (
        <label className="pipe-scene-select">Scene<select value={scene} onChange={(e) => { setScene(e.target.value); setLimit(30) }}><option value="">All scenes</option>{scenes.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
      )}
      {shown.length === 0 && <p className="dossier-note">Nothing planned here yet.</p>}
      <ul className="bp-prompts">{shown.slice(0, limit).map(({ p, label }) => <PromptCard key={p.id} p={p} label={label} api={api} projectId={projectId} onSaved={load} />)}</ul>
      {shown.length > limit && <button type="button" className="dossier-small-button" onClick={() => setLimit(limit + 30)}>Show 30 more ({shown.length - limit} left)</button>}
    </div>
  )
}

export default function Blueprint({ projectId, backendUrl, onNavigate }) {
  const api = `${backendUrl}/api/production`
  const [tab, setTab] = useState('overview')
  const [bp, setBp] = useState(null)
  const [manifest, setManifest] = useState(null)
  const reload = useCallback(async () => {
    const [a, b] = await Promise.all([call(`${api}/${projectId}/blueprint`), call(`${api}/${projectId}/manifest`)])
    if (a.ok) setBp(a.data)
    if (b.ok) setManifest(b.data)
  }, [api, projectId])
  useEffect(() => { reload() }, [reload, tab])
  useLive(projectId, backendUrl, reload)
  const tabs = [
    { key: 'overview', label: 'Overview' }, { key: 'shots', label: 'Shots' }, { key: 'storyboard', label: 'Storyboard text' },
    { key: 'prompts', label: 'Prompts' }, { key: 'assets', label: 'Assets & dossier' },
  ]
  return (
    <div className="bp">
      <nav className="dossier-tabs" aria-label="Production Blueprint sections">
        {tabs.map((t) => <button key={t.key} type="button" className={tab === t.key ? 'dossier-tab active' : 'dossier-tab'} onClick={() => setTab(t.key)}>{t.label}</button>)}
        <button type="button" className="dossier-tab" onClick={() => onNavigate?.('cinematic')}>Cinematic Director ↗</button>
      </nav>
      {tab === 'overview' && <Overview api={api} projectId={projectId} bp={bp} manifest={manifest} reload={reload} onTab={setTab} />}
      {tab === 'shots' && (
        <>
          <ShotOptimization projectId={projectId} backendUrl={backendUrl} onChanged={reload} />
          <PipelineStage stage="shots" projectId={projectId} backendUrl={backendUrl} />
        </>
      )}
      {tab === 'storyboard' && <PipelineStage stage="storyboard" projectId={projectId} backendUrl={backendUrl} />}
      {tab === 'prompts' && <Prompts api={api} projectId={projectId} manifest={manifest} />}
      {tab === 'assets' && <ProductionDossier projectId={projectId} backendUrl={backendUrl} />}
    </div>
  )
}
