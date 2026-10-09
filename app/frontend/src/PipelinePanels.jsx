// The AI production screens (pipeline steps 2-8): shots and text storyboard,
// reference art, shot pictures, voices, video takes, and assemble/export.
// Every number comes from saved records; every paid action shows its estimated
// cost first and the backend refuses anything over the project's money limit.
import { useCallback, useEffect, useState } from 'react'
import './Pipeline.css'

async function call(url, method = 'GET', body) {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, data }
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } }
  }
}

const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function useScenes(api, projectId) {
  const [scenes, setScenes] = useState([])
  useEffect(() => {
    let cancelled = false
    fetch(`${api}/${projectId}/scenes`).then((r) => (r.ok ? r.json() : { scenes: [] })).then((d) => { if (!cancelled) setScenes(d.scenes) }).catch(() => {})
    return () => { cancelled = true }
  }, [api, projectId])
  return scenes
}

function SceneSelect({ scenes, sceneId, onChange }) {
  if (scenes.length === 0) return <p className="dossier-note">No scenes yet. Open the Scenes tab and press “Analyze the screenplay” first.</p>
  return (
    <label className="pipe-scene-select">
      Scene
      <select value={sceneId ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Choose a scene…</option>
        {scenes.map((s) => <option key={s.id} value={s.id}>{s.code} · Scene {s.number} · {s.heading}</option>)}
      </select>
    </label>
  )
}

function Notice({ message }) {
  if (!message) return null
  return <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>{message.text}</p>
}

// Loads generations (pictures / voices / video) and keeps refreshing while any is still being made.
function useGenerations(api, projectId, query, onChanged) {
  const [gens, setGens] = useState([])
  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/generations${query ? `?${query}` : ''}`)
    if (r.ok) setGens(r.data.generations)
    return r.ok ? r.data.generations : []
  }, [api, projectId, query])
  useEffect(() => { load() }, [load])
  const running = gens.some((g) => g.status === 'running')
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(async () => {
      const list = await load()
      if (!list.some((g) => g.status === 'running') && onChanged) onChanged()
    }, 3000)
    return () => clearInterval(timer)
  }, [running, load, onChanged])
  return { gens, load, running }
}

function Media({ g, backendUrl }) {
  if (g.status === 'running') return <div className="pipe-media pipe-working" aria-live="polite">Making this…</div>
  if (g.status === 'failed') return <div className="pipe-media pipe-failed" role="alert">{g.error || 'This did not work.'}</div>
  const src = `${backendUrl}${g.mediaUrl}`
  if (g.kind === 'audio') return <audio className="pipe-audio" controls preload="none" src={src} />
  if (g.kind === 'video') return <video className="pipe-media" controls preload="metadata" src={src} />
  return <a href={src} target="_blank" rel="noreferrer"><img className="pipe-media" src={src} alt={`${g.kind} version ${g.version}`} loading="lazy" /></a>
}

function GenCard({ g, backendUrl, api, projectId, onChanged, label }) {
  const [busy, setBusy] = useState(false)
  async function review(decision) {
    setBusy(true)
    await call(`${api}/${projectId}/generations/${g.id}/review`, 'POST', { decision })
    setBusy(false)
    onChanged()
  }
  return (
    <figure className={`pipe-card ${g.review}`}>
      <Media g={g} backendUrl={backendUrl} />
      <figcaption>
        <span className="pipe-version">{label ?? `Version ${g.version}`}</span>
        {g.review === 'approved' && <span className="dossier-badge edited">Approved</span>}
        {g.review === 'rejected' && <span className="dossier-badge issues">Rejected</span>}
        {g.outdated && <span className="dossier-badge stale" title="A reference picture was replaced after this was made.">Out of date</span>}
        {g.status === 'ready' && <span className="dossier-fine-print"> {usd(g.costUsd)}</span>}
        {g.status === 'ready' && (
          <span className="pipe-card-buttons">
            {g.review !== 'approved' && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => review('approve')}>Approve</button>}
            {g.review === 'approved' && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => review('reset')}>Un-approve</button>}
            {g.review === 'pending' && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => review('reject')}>Reject</button>}
          </span>
        )}
        <details className="dossier-original"><summary>What was asked</summary><p className="dossier-fine-print">{g.prompt}</p></details>
      </figcaption>
    </figure>
  )
}

// ---------------------------------------------------------------------------
// Progress strip, money and look settings
// ---------------------------------------------------------------------------

export function PipelineBar({ pipeline, api, projectId, onSaved }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(null)
  const [message, setMessage] = useState(null)
  if (!pipeline) return null
  const { status, spend, settings } = pipeline
  const pct = spend.limitUsd > 0 ? Math.min(100, Math.round((spend.spentUsd / spend.limitUsd) * 100)) : 100
  const chip = (label, done, total) => <span className={done >= total && total > 0 ? 'pipe-chip done' : 'pipe-chip'}>{label} {done}/{total}</span>

  async function save(e) {
    e.preventDefault()
    const r = await call(`${api}/${projectId}/settings`, 'PATCH', {
      stylePrompt: form.stylePrompt, aspectRatio: form.aspectRatio, budgetLimitUsd: form.budget === '' ? null : Number(form.budget),
    })
    if (!r.ok) { setMessage({ tone: 'bad', text: r.data.error }); return }
    setMessage({ tone: 'ok', text: 'Saved.' })
    setOpen(false)
    onSaved()
  }

  return (
    <section className="pipe-bar" aria-label="Production progress">
      <div className="pipe-chips">
        <span className="pipe-chip">Scenes {status.scenes}</span>
        {chip('Shots approved', status.shots.shotsApproved, status.shots.total)}
        {chip('Characters', status.references.characters.approved, status.references.characters.total)}
        {chip('Props', status.references.props.approved, status.references.props.total)}
        {chip('Places', status.references.environments.approved, status.references.environments.total)}
        {chip('Shot pictures', status.keyframes.approved, status.keyframes.of)}
        {chip('Voices', status.audio.approved, status.audio.of)}
        {chip('Video', status.video.approved, status.video.of)}
      </div>
      <div className="pipe-money">
        <span>Spent {usd(spend.spentUsd)} of {usd(spend.limitUsd)} limit</span>
        <span className="pipe-meter" aria-hidden="true"><span style={{ width: `${pct}%` }} className={pct >= 90 ? 'hot' : ''} /></span>
        <button type="button" className="dossier-small-button" onClick={() => { setForm({ stylePrompt: settings.stylePrompt, aspectRatio: settings.aspectRatio, budget: settings.budgetLimitUsd ?? '' }); setOpen(!open) }}>
          {open ? 'Close settings' : 'Look & money limit'}
        </button>
      </div>
      {open && form && (
        <form className="pipe-settings" onSubmit={save}>
          <label className="dossier-field">The look of the film (added to every picture and video request)
            <textarea rows={3} maxLength={2000} value={form.stylePrompt} placeholder="e.g. realistic, warm morning light, shallow depth of field" onChange={(e) => setForm({ ...form, stylePrompt: e.target.value })} />
          </label>
          <div className="dossier-controls-row">
            <label className="dossier-field">Picture shape
              <select value={form.aspectRatio} onChange={(e) => setForm({ ...form, aspectRatio: e.target.value })}>
                {['16:9', '9:16', '1:1', '4:3', '3:4'].map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="dossier-field">Money limit for this project (US dollars)
              <input type="number" min="0" step="0.5" value={form.budget} placeholder={`${settings.effectiveBudgetUsd} (default)`} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
            </label>
          </div>
          <p className="dossier-fine-print">Prices are estimates (picture ≈ {usd(spend.prices.image)}, video ≈ {usd(spend.prices.videoPerSecond)} per second). The app refuses to start anything that would go over the limit.</p>
          <button type="submit" className="dossier-small-button">Save</button>
        </form>
      )}
      <Notice message={message} />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Steps 2-3: shot division (its own stage) and the text storyboard (its own stage)
// ---------------------------------------------------------------------------

// view 'division': camera details + add / split / merge / delete. view 'storyboard': the written picture text.
function ShotEditor({ shot, api, projectId, onChanged, setMessage, view = 'division' }) {
  const [edit, setEdit] = useState(null)
  async function act(promise, okText) {
    const r = await promise
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'That did not work.' })
    else if (okText) setMessage({ tone: 'ok', text: okText })
    onChanged()
    return r
  }
  async function save(e) {
    e.preventDefault()
    const edits = view === 'division'
      ? { framing: edit.framing, cameraAngle: edit.cameraAngle, cameraMove: edit.cameraMove, description: edit.description, durationSec: Number(edit.durationSec) }
      : { storyboardText: edit.storyboardText }
    const r = await act(call(`${api}/${projectId}/shots/${shot.id}`, 'PATCH', { expectedRevision: shot.revision, edits }))
    if (r.ok) setEdit(null)
  }
  const people = shot.assets.map((a) => a.name).join(', ')
  const locked = false
  return (
    <li className="pipe-shot">
      <div className="pipe-shot-head">
        <strong>{shot.number}</strong> <span className="dossier-code">{shot.code}</span>
        <span className="pipe-shot-camera">{[shot.framing, shot.cameraAngle, shot.cameraMove].filter(Boolean).join(' · ') || 'no camera set'} · {shot.durationSec}s</span>
        {view === 'division' && shot.shotStatus === 'approved' && <span className="dossier-badge edited">Approved</span>}
        {view === 'storyboard' && shot.storyboardStatus === 'approved' && <span className="dossier-badge edited">Storyboard approved</span>}
        {shot.source === 'ai' && <span className="dossier-badge">AI cut</span>}
      </div>
      {edit ? (
        <form onSubmit={save}>
          {view === 'division' ? (
            <>
              <div className="dossier-controls-row">
                <label className="dossier-field">Framing<input value={edit.framing ?? ''} onChange={(e) => setEdit({ ...edit, framing: e.target.value })} /></label>
                <label className="dossier-field">Angle<input value={edit.cameraAngle ?? ''} onChange={(e) => setEdit({ ...edit, cameraAngle: e.target.value })} /></label>
                <label className="dossier-field">Movement<input value={edit.cameraMove ?? ''} onChange={(e) => setEdit({ ...edit, cameraMove: e.target.value })} /></label>
                <label className="dossier-field">Seconds<input type="number" min="1" max="30" step="0.5" value={edit.durationSec} onChange={(e) => setEdit({ ...edit, durationSec: e.target.value })} /></label>
              </div>
              <label className="dossier-field">What the camera sees<textarea rows={3} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            </>
          ) : (
            <label className="dossier-field">Storyboard text<textarea rows={5} value={edit.storyboardText} onChange={(e) => setEdit({ ...edit, storyboardText: e.target.value })} /></label>
          )}
          <div className="dossier-save-row">
            <button type="submit" className="dossier-small-button">Save shot</button>
            <button type="button" className="dossier-small-button" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <p>{shot.description}</p>
          {view === 'storyboard' && (shot.storyboardText ? <p className="pipe-storyboard"><em>Storyboard:</em> {shot.storyboardText}</p> : <p className="dossier-fine-print">No storyboard text yet.</p>)}
          {people && <p className="dossier-fine-print">In this shot: {people}</p>}
          {shot.dialogue.length > 0 && (
            <ul className="pipe-lines">{shot.dialogue.map((d) => <li key={d.id}><span className="dossier-code">{d.code}</span> <strong>{d.speaker}</strong>: {d.text}</li>)}</ul>
          )}
          <div className="pipe-card-buttons">
            <button type="button" className="dossier-small-button" onClick={() => setEdit(view === 'division'
              ? { framing: shot.framing, cameraAngle: shot.cameraAngle, cameraMove: shot.cameraMove, description: shot.description, durationSec: shot.durationSec }
              : { storyboardText: shot.storyboardText })}>Edit</button>
            {view === 'division' && (
              <>
                <button type="button" className="dossier-small-button" disabled={locked} onClick={() => act(call(`${api}/${projectId}/scenes/${shot.sceneId}/shots`, 'POST', { afterShotId: shot.id, description: 'New shot' }))}>Add a shot after</button>
                <button type="button" className="dossier-small-button" onClick={() => act(call(`${api}/${projectId}/shots/${shot.id}/split`, 'POST', {}))}>Split</button>
                <button type="button" className="dossier-small-button" onClick={() => act(call(`${api}/${projectId}/shots/${shot.id}/merge-next`, 'POST', {}))}>Merge with next</button>
                <button type="button" className="dossier-small-button" onClick={() => { if (window.confirm(`Remove shot ${shot.number}?`)) act(call(`${api}/${projectId}/shots/${shot.id}`, 'DELETE')) }}>Remove</button>
              </>
            )}
          </div>
        </>
      )}
    </li>
  )
}

// Runs one request per scene, one after another, and reports progress.
async function runScenes(sceneIds, label, setProgress, makeRequest) {
  const results = { done: 0, failed: [] }
  for (let i = 0; i < sceneIds.length; i++) {
    setProgress(`${label} scene ${i + 1} of ${sceneIds.length}…`)
    const r = await makeRequest(sceneIds[i])
    if (r.ok) results.done++
    else results.failed.push({ sceneId: sceneIds[i], error: r.data.error || 'failed', status: r.status })
  }
  setProgress(null)
  return results
}

function useAllShots(api, projectId) {
  const [shots, setShots] = useState([])
  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/shots`)
    if (r.ok) setShots(r.data.shots)
  }, [api, projectId])
  useEffect(() => { load() }, [load])
  return { shots, reloadAll: load }
}

export function ShotDivisionPanel({ projectId, api, sceneId, onSceneChange, onChanged, pipeline }) {
  const scenes = useScenes(api, projectId)
  const { shots: allShots, reloadAll } = useAllShots(api, projectId)
  const [selected, setSelected] = useState([])
  const [mode, setMode] = useState('ai')
  const [replace, setReplace] = useState(false)
  const [progress, setProgress] = useState(null)
  const [message, setMessage] = useState(null)
  const aiOn = pipeline?.providers?.textAvailable

  const shotsOf = (id) => allShots.filter((s) => s.sceneId === id)
  const statusOf = (id) => {
    const list = shotsOf(id)
    if (list.length === 0) return 'none'
    return list.every((s) => s.shotStatus === 'approved') ? 'approved' : 'draft'
  }
  const changed = () => { reloadAll(); if (onChanged) onChanged() }
  const busy = progress !== null

  async function autoDivide(ids) {
    const todo = ids.filter((id) => replace || shotsOf(id).length === 0)
    const skipped = ids.length - todo.length
    if (todo.length === 0) { setMessage({ tone: 'ok', text: 'Nothing to do: every chosen scene already has shots. Tick “Cut again even if the scene already has shots” to redo them.' }); return }
    if (replace && !window.confirm(`Cut ${todo.length} scene${todo.length > 1 ? 's' : ''} again? Their current shots will be replaced and need approving again.`)) return
    setMessage(null)
    const result = await runScenes(todo, mode === 'ai' ? 'AI is cutting' : 'Cutting', setProgress, (id) => call(`${api}/${projectId}/scenes/${id}/divide`, 'POST', { mode, replace: replace && shotsOf(id).length > 0 }))
    await reloadAll()
    if (onChanged) onChanged()
    const names = (id) => scenes.find((s) => s.id === id)?.code ?? id
    setMessage({
      tone: result.failed.length ? 'bad' : 'ok',
      text: `Cut ${result.done} scene${result.done === 1 ? '' : 's'}${skipped ? `, left ${skipped} that already had shots` : ''}.${result.failed.length ? ` Could not cut: ${result.failed.map((f) => `${names(f.sceneId)} (${f.error})`).join('; ')}` : ' Now check them, edit if needed, and approve.'}`,
    })
  }

  async function approveMany(ids, approved) {
    const todo = ids.filter((id) => shotsOf(id).length > 0)
    const result = await runScenes(todo, approved ? 'Approving' : 'Un-approving', setProgress, (id) => call(`${api}/${projectId}/scenes/${id}/shots/approve`, 'POST', { approved }))
    await reloadAll()
    if (onChanged) onChanged()
    setMessage({ tone: result.failed.length ? 'bad' : 'ok', text: `${approved ? 'Approved' : 'Un-approved'} ${result.done} scene${result.done === 1 ? '' : 's'}.` })
  }

  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  const sceneShots = sceneId ? shotsOf(sceneId) : []
  const openScene = scenes.find((s) => s.id === sceneId)

  if (scenes.length === 0) return <p className="dossier-note">No scenes yet. Open the Production Dossier → Scenes and press “Analyze the screenplay” first.</p>
  return (
    <div className="pipe-panel">
      <div className="pipe-toolbar">
        <label className="dossier-field pipe-inline">Cut with
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={busy}>
            <option value="ai" disabled={!aiOn}>The AI{aiOn ? '' : ' (not available)'}</option>
            <option value="script">The shot notes written in the script</option>
            <option value="auto">Best available (script notes, then AI)</option>
            <option value="rules">A simple cut (no AI)</option>
          </select>
        </label>
        <label className="pipe-inline"><input type="checkbox" checked={replace} disabled={busy} onChange={(e) => setReplace(e.target.checked)} /> Cut again even if the scene already has shots</label>
      </div>
      <div className="pipe-toolbar">
        <button type="button" className="dossier-small-button" disabled={busy || selected.length === 0} onClick={() => autoDivide(scenes.filter((s) => selected.includes(s.id)).map((s) => s.id))}>Auto-divide selected scenes ({selected.length})</button>
        <button type="button" className="dossier-small-button" disabled={busy} onClick={() => autoDivide(scenes.map((s) => s.id))}>Auto-divide ALL scenes</button>
        <button type="button" className="dossier-small-button" disabled={busy || selected.length === 0} onClick={() => approveMany(selected, true)}>Approve selected</button>
        <button type="button" className="dossier-small-button" disabled={busy} onClick={() => approveMany(scenes.map((s) => s.id), true)}>Approve all</button>
        <button type="button" className="dossier-small-button" disabled={busy} onClick={() => setSelected(selected.length === scenes.length ? [] : scenes.map((s) => s.id))}>{selected.length === scenes.length ? 'Clear ticks' : 'Tick all'}</button>
      </div>
      {progress && <p className="dossier-message" role="status">{progress}</p>}
      <Notice message={message} />
      <ul className="pipe-items" aria-label="Scenes">
        {scenes.map((s) => {
          const st = statusOf(s.id)
          return (
            <li key={s.id} className={`pipe-item pipe-scene-row${sceneId === s.id ? ' open' : ''}`}>
              <label className="pipe-inline"><input type="checkbox" checked={selected.includes(s.id)} disabled={busy} onChange={() => toggle(s.id)} aria-label={`Select ${s.code}`} /></label>
              <button type="button" className="pipe-scene-name" onClick={() => onSceneChange(sceneId === s.id ? null : s.id)}>
                <span className="dossier-code">{s.code}</span> Scene {s.number} · {s.heading}
              </button>
              <span className="dossier-fine-print">{shotsOf(s.id).length} shots</span>
              {st === 'approved' && <span className="dossier-badge edited">Approved</span>}
              {st === 'draft' && <span className="dossier-badge stale">Needs approval</span>}
              {st === 'none' && <span className="dossier-fine-print">not cut yet</span>}
            </li>
          )
        })}
      </ul>
      {openScene && (
        <section className="pipe-group">
          <div className="pipe-group-head">
            <h3>{openScene.code} · Scene {openScene.number} <span className="dossier-fine-print">{openScene.heading}</span></h3>
            <div className="pipe-card-buttons">
              <button type="button" className="dossier-small-button" disabled={busy} onClick={() => autoDivide([openScene.id])}>{sceneShots.length ? 'Cut this scene again' : 'Cut this scene'}</button>
              <button type="button" className="dossier-small-button" disabled={busy || sceneShots.length === 0} onClick={() => approveMany([openScene.id], statusOf(openScene.id) !== 'approved')}>{statusOf(openScene.id) === 'approved' ? 'Un-approve' : 'Approve this scene'}</button>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={async () => { const r = await call(`${api}/${projectId}/scenes/${openScene.id}/shots`, 'POST', { description: 'New shot' }); if (!r.ok) setMessage({ tone: 'bad', text: r.data.error }); changed() }}>Add a shot at the end</button>
            </div>
          </div>
          <p className="dossier-fine-print">Edit, add, split, merge or remove shots until the scene is cut the way you want, then approve it. Any change after approving asks for approval again. Pictures can only be made for approved scenes.</p>
          {sceneShots.length === 0 ? <p className="dossier-empty">No shots yet for this scene.</p> : (
            <ol className="pipe-shots">{sceneShots.map((s) => <ShotEditor key={`${s.id}-${s.revision}`} shot={s} api={api} projectId={projectId} onChanged={changed} setMessage={setMessage} view="division" />)}</ol>
          )}
        </section>
      )}
    </div>
  )
}

export function StoryboardPanel({ projectId, api, sceneId, onSceneChange, onChanged, pipeline }) {
  const scenes = useScenes(api, projectId)
  const { shots: allShots, reloadAll } = useAllShots(api, projectId)
  const [progress, setProgress] = useState(null)
  const [message, setMessage] = useState(null)
  const shotsOf = (id) => allShots.filter((s) => s.sceneId === id)
  const withShots = scenes.filter((s) => shotsOf(s.id).length > 0)
  const changed = () => { reloadAll(); if (onChanged) onChanged() }
  const busy = progress !== null
  const sceneShots = sceneId ? shotsOf(sceneId) : []
  const approved = sceneShots.length > 0 && sceneShots.every((s) => s.storyboardStatus === 'approved')
  const hasText = sceneShots.length > 0 && sceneShots.every((s) => s.storyboardText)
  const aiOn = pipeline?.providers?.textAvailable

  async function writeAll() {
    const result = await runScenes(withShots.map((s) => s.id), 'Writing', setProgress, (id) => call(`${api}/${projectId}/scenes/${id}/storyboard`, 'POST', {}))
    await reloadAll()
    if (onChanged) onChanged()
    setMessage({ tone: result.failed.length ? 'bad' : 'ok', text: `Wrote storyboard text for ${result.done} scene${result.done === 1 ? '' : 's'} (only shots without text; yours are kept).${result.failed.length ? ` ${result.failed.length} failed: ${result.failed[0].error}` : ''}` })
  }
  async function writeOne(overwrite) {
    setProgress('Writing…')
    const r = await call(`${api}/${projectId}/scenes/${sceneId}/storyboard`, 'POST', { overwrite })
    setProgress(null)
    setMessage(r.ok ? { tone: 'ok', text: `Wrote ${r.data.written} storyboard texts (${r.data.mode === 'ai' ? 'by the AI' : 'from the shot details'}).` } : { tone: 'bad', text: r.data.error })
    changed()
  }
  async function approveOne() {
    const r = await call(`${api}/${projectId}/scenes/${sceneId}/storyboard/approve`, 'POST', { approved: !approved })
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error })
    changed()
  }

  return (
    <div className="pipe-panel">
      <p className="dossier-fine-print">The text storyboard describes what each shot's picture shows — no images. It comes after the shot pictures: it is used to refine them and as the written record.{aiOn ? '' : ' The AI is not available right now, so texts are built from the shot details.'}</p>
      <div className="pipe-toolbar">
        <button type="button" className="dossier-small-button" disabled={busy || withShots.length === 0} onClick={writeAll}>Write storyboard text for ALL scenes</button>
      </div>
      {progress && <p className="dossier-message" role="status">{progress}</p>}
      <SceneSelect scenes={withShots.length ? withShots : scenes} sceneId={sceneId} onChange={onSceneChange} />
      <Notice message={message} />
      {withShots.length === 0 && <p className="dossier-empty">No scene has shots yet. Use the Shot division stage first.</p>}
      {sceneId && (
        <>
          <div className="pipe-toolbar">
            <button type="button" className="dossier-small-button" disabled={busy || sceneShots.length === 0} onClick={() => writeOne(false)}>Write storyboard text</button>
            <button type="button" className="dossier-small-button" disabled={busy || !hasText} onClick={() => { if (window.confirm('Rewrite the storyboard text of every shot in this scene (your edits will be replaced)?')) writeOne(true) }}>Rewrite all text</button>
            <button type="button" className="dossier-small-button" disabled={busy || !hasText} onClick={approveOne}>{approved ? 'Un-approve storyboard' : 'Approve storyboard'}</button>
          </div>
          {sceneShots.length === 0 ? <p className="dossier-empty">This scene has no shots yet.</p> : (
            <ol className="pipe-shots">{sceneShots.map((s) => <ShotEditor key={`${s.id}-${s.revision}`} shot={s} api={api} projectId={projectId} onChanged={changed} setMessage={setMessage} view="storyboard" />)}</ol>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 4: reference art (characters, then props, then places)
// ---------------------------------------------------------------------------

const ART_GROUPS = [
  { kind: 'character', title: '1. Characters', make: 'character' },
  { kind: 'prop', title: '2. Props', make: 'prop' },
  { kind: 'other', title: '2b. Other items', make: 'prop' },
  { kind: 'location', title: '3. Places', make: 'environment' },
]

function ArtItem({ asset, gens, backendUrl, api, projectId, onChanged, makeKind, setMessage }) {
  const [busy, setBusy] = useState(false)
  const mine = gens.filter((g) => g.assetId === asset.id)
  const approved = mine.find((g) => g.review === 'approved')
  const running = mine.some((g) => g.status === 'running')
  async function make() {
    setBusy(true)
    const r = await call(`${api}/${projectId}/generate`, 'POST', { kind: makeKind, targetIds: [asset.id] })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error })
    onChanged()
  }
  return (
    <li className="pipe-item">
      <div className="pipe-item-head">
        <span className="dossier-code">{asset.code}</span> <strong>{asset.name}</strong>
        {approved ? <span className="dossier-badge edited">Reference approved</span> : <span className="dossier-fine-print">no approved picture yet</span>}
        <button type="button" className="dossier-small-button" disabled={busy || running} onClick={make}>{mine.length ? 'Make another' : 'Make picture'}</button>
      </div>
      {mine.length > 0 && <div className="pipe-grid pipe-grid-wide">{mine.map((g) => <GenCard key={g.id} g={g} backendUrl={backendUrl} api={api} projectId={projectId} onChanged={onChanged} />)}</div>}
    </li>
  )
}

export function ArtPanel({ projectId, api, backendUrl, assets, pipeline, onChanged, only = null }) {
  const [message, setMessage] = useState(null)
  const { gens, load } = useGenerations(api, projectId, '', onChanged)
  const changed = () => { load(); if (onChanged) onChanged() }
  const refs = gens.filter((g) => ['character', 'prop', 'environment'].includes(g.kind))
  const price = pipeline?.spend?.prices?.image ?? 0.04

  async function makeAll(group, list) {
    const todo = list.filter((a) => !refs.some((g) => g.assetId === a.id))
    if (todo.length === 0) { setMessage({ tone: 'ok', text: 'Every item in this group already has a picture.' }); return }
    if (!window.confirm(`Make ${todo.length} picture${todo.length > 1 ? 's' : ''}? Estimated cost about ${usd(todo.length * price)}.`)) return
    const r = await call(`${api}/${projectId}/generate`, 'POST', { kind: group.make, targetIds: todo.map((a) => a.id) })
    setMessage(r.ok ? { tone: 'ok', text: `Started ${r.data.started.length} picture${r.data.started.length > 1 ? 's' : ''}.${r.data.skipped.length ? ` ${r.data.skipped.length} skipped: ${r.data.skipped[0].reason}` : ''}` } : { tone: 'bad', text: r.data.error })
    changed()
  }

  return (
    <div className="pipe-panel">
      <p className="dossier-fine-print">Each item gets ONE model sheet image (characters: face close-up, profile, 3/4, full-body front/side/back and expressions; props: all angles and details; environments: wide view, other angles, details and lighting). Approve one sheet per item — these approved pictures are what every shot picture is drawn from. Order: characters first, then props, then environments.</p>
      <Notice message={message} />
      {ART_GROUPS.filter((g) => !only || g.kind === only).map((group) => {
        const list = assets.filter((a) => a.kind === group.kind)
        if (list.length === 0) return null
        return (
          <section key={group.kind} className="pipe-group">
            <div className="pipe-group-head">
              <h3>{group.title} <span className="dossier-fine-print">{list.filter((a) => refs.some((g) => g.assetId === a.id && g.review === 'approved')).length}/{list.length} approved</span></h3>
              <button type="button" className="dossier-small-button" onClick={() => makeAll(group, list)}>Make all missing</button>
            </div>
            <ul className="pipe-items">
              {list.map((a) => <ArtItem key={a.id} asset={a} gens={refs} backendUrl={backendUrl} api={api} projectId={projectId} onChanged={changed} makeKind={group.make} setMessage={setMessage} />)}
            </ul>
          </section>
        )
      })}
      {assets.filter((a) => !only || a.kind === only).length === 0 && <p className="dossier-empty">Nothing of this kind in the dossier yet. Import from the agent first (Production Dossier).</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 5: a picture for every shot
// ---------------------------------------------------------------------------

function useSceneShots(api, projectId, sceneId) {
  const [shots, setShots] = useState([])
  const load = useCallback(async () => {
    if (!sceneId) { setShots([]); return }
    const r = await call(`${api}/${projectId}/shots?sceneId=${sceneId}`)
    if (r.ok) setShots(r.data.shots)
  }, [api, projectId, sceneId])
  useEffect(() => { load() }, [load])
  return { shots, reloadShots: load }
}

export function FramesPanel({ projectId, api, backendUrl, sceneId, onSceneChange, pipeline, onChanged }) {
  const scenes = useScenes(api, projectId)
  const { shots } = useSceneShots(api, projectId, sceneId)
  const [message, setMessage] = useState(null)
  const [allowMissing, setAllowMissing] = useState(false)
  const { gens, load } = useGenerations(api, projectId, '', onChanged)
  const changed = () => { load(); if (onChanged) onChanged() }
  const price = pipeline?.spend?.prices?.image ?? 0.04
  const approvedRef = (assetId) => gens.some((g) => g.assetId === assetId && g.review === 'approved' && ['character', 'prop', 'environment'].includes(g.kind))

  async function make(ids) {
    if (ids.length > 1 && !window.confirm(`Make ${ids.length} pictures? Estimated cost about ${usd(ids.length * price)}.`)) return
    const r = await call(`${api}/${projectId}/generate`, 'POST', { kind: 'keyframe', targetIds: ids, allowMissing })
    setMessage(r.ok ? { tone: 'ok', text: `Started ${r.data.started.length} picture${r.data.started.length > 1 ? 's' : ''}.${r.data.skipped.length ? ` ${r.data.skipped.length} could not start: ${r.data.skipped[0].reason}` : ''}` } : { tone: 'bad', text: r.data.error })
    changed()
  }

  return (
    <div className="pipe-panel">
      <SceneSelect scenes={scenes} sceneId={sceneId} onChange={onSceneChange} />
      <Notice message={message} />
      {sceneId && shots.length === 0 && <p className="dossier-empty">This scene has no shots yet. Use the Shot division stage first.</p>}
      {sceneId && shots.length > 0 && (
        <>
          <div className="pipe-toolbar">
            <button type="button" className="dossier-small-button" onClick={() => make(shots.filter((s) => !gens.some((g) => g.shotId === s.id && g.kind === 'keyframe')).map((s) => s.id))}>Make pictures for shots without one</button>
            <label className="pipe-inline"><input type="checkbox" checked={allowMissing} onChange={(e) => setAllowMissing(e.target.checked)} /> Go ahead even if a reference picture is missing</label>
          </div>
          <ol className="pipe-shots">
            {shots.map((s) => {
              const mine = gens.filter((g) => g.shotId === s.id && g.kind === 'keyframe')
              const needed = s.assets.filter((a) => ['character', 'location', 'prop'].includes(a.kind))
              const missing = needed.filter((a) => !approvedRef(a.id))
              const blocked = s.shotStatus !== 'approved' ? 'Approve the shot division of this scene first' : (!allowMissing && missing.length > 0 ? `Needs approved references: ${missing.map((m) => m.name).join(', ')}` : null)
              return (
                <li key={s.id} className="pipe-shot">
                  <div className="pipe-shot-head"><strong>{s.number}</strong> <span className="dossier-code">{s.code}</span> <span className="pipe-shot-camera">{[s.framing, s.cameraAngle, s.cameraMove].filter(Boolean).join(' · ')}</span></div>
                  <p>{s.storyboardText || s.description}</p>
                  <p className="dossier-fine-print">References: {needed.length === 0 ? 'none needed' : needed.map((a) => `${a.name} ${approvedRef(a.id) ? '✓' : '✗'}`).join(', ')}</p>
                  <div className="pipe-card-buttons">
                    <button type="button" className="dossier-small-button" disabled={Boolean(blocked) || mine.some((g) => g.status === 'running')} title={blocked ?? undefined} onClick={() => make([s.id])}>{mine.length ? 'Make another' : 'Make picture'}</button>
                    {blocked && <span className="dossier-fine-print">{blocked}</span>}
                  </div>
                  {mine.length > 0 && <div className="pipe-grid">{mine.map((g) => <GenCard key={g.id} g={g} backendUrl={backendUrl} api={api} projectId={projectId} onChanged={changed} />)}</div>}
                </li>
              )
            })}
          </ol>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 6: voices
// ---------------------------------------------------------------------------

export function VoicePanel({ projectId, api, backendUrl, sceneId, onSceneChange, pipeline, onChanged }) {
  const scenes = useScenes(api, projectId)
  const [scene, setScene] = useState(null)
  const [message, setMessage] = useState(null)
  const { gens, load } = useGenerations(api, projectId, sceneId ? `kind=audio&sceneId=${sceneId}` : 'kind=audio', onChanged)
  const changed = () => { load(); if (onChanged) onChanged() }
  useEffect(() => {
    if (!sceneId) { setScene(null); return }
    fetch(`${api}/${projectId}/scenes/${sceneId}`).then((r) => (r.ok ? r.json() : null)).then(setScene).catch(() => {})
  }, [api, projectId, sceneId])
  const lines = (scene?.elements ?? []).filter((e) => e.kind === 'dialogue')
  const speakers = [...new Set(lines.map((l) => l.speaker))]
  const voices = pipeline?.voices ?? []
  const saved = pipeline?.settings?.voices ?? {}
  const price = pipeline?.spend?.prices?.audioPerThousandChars ?? 0.02

  async function setVoice(speaker, voice) {
    const r = await call(`${api}/${projectId}/settings`, 'PATCH', { voices: { ...saved, [speaker]: voice } })
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error })
    if (onChanged) onChanged()
  }
  async function make(ids) {
    const chars = lines.filter((l) => ids.includes(l.id)).reduce((n, l) => n + l.text.length, 0)
    if (ids.length > 1 && !window.confirm(`Make ${ids.length} voice lines? Estimated cost about ${usd((chars / 1000) * price)}.`)) return
    const r = await call(`${api}/${projectId}/generate`, 'POST', { kind: 'audio', targetIds: ids })
    setMessage(r.ok ? { tone: 'ok', text: `Started ${r.data.started.length} voice line${r.data.started.length > 1 ? 's' : ''}.` } : { tone: 'bad', text: r.data.error })
    changed()
  }

  return (
    <div className="pipe-panel">
      <SceneSelect scenes={scenes} sceneId={sceneId} onChange={onSceneChange} />
      <Notice message={message} />
      {sceneId && lines.length === 0 && <p className="dossier-empty">This scene has no dialogue lines.</p>}
      {lines.length > 0 && (
        <>
          <div className="pipe-toolbar">
            {speakers.map((sp) => (
              <label key={sp} className="dossier-field pipe-inline">{sp}
                <select value={saved[sp] ?? ''} onChange={(e) => e.target.value && setVoice(sp, e.target.value)}>
                  <option value="">Automatic voice</option>
                  {voices.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            ))}
            <button type="button" className="dossier-small-button" onClick={() => make(lines.filter((l) => !gens.some((g) => g.elementId === l.id)).map((l) => l.id))}>Make voices for lines without one</button>
          </div>
          <ul className="pipe-items">
            {lines.map((l) => {
              const mine = gens.filter((g) => g.elementId === l.id)
              return (
                <li key={l.id} className="pipe-item">
                  <div className="pipe-item-head">
                    <span className="dossier-code">{l.code}</span> <strong>{l.speaker}</strong>{l.parenthetical ? <em> ({l.parenthetical})</em> : null}
                    <button type="button" className="dossier-small-button" disabled={mine.some((g) => g.status === 'running')} onClick={() => make([l.id])}>{mine.length ? 'Make another' : 'Make voice'}</button>
                  </div>
                  <p>{l.text}</p>
                  {mine.length > 0 && <div className="pipe-grid pipe-grid-wide">{mine.map((g) => <GenCard key={g.id} g={g} backendUrl={backendUrl} api={api} projectId={projectId} onChanged={changed} />)}</div>}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 7: video takes
// ---------------------------------------------------------------------------

export function VideoPanel({ projectId, api, backendUrl, sceneId, onSceneChange, pipeline, onChanged }) {
  const scenes = useScenes(api, projectId)
  const { shots } = useSceneShots(api, projectId, sceneId)
  const [message, setMessage] = useState(null)
  const { gens, load } = useGenerations(api, projectId, sceneId ? `sceneId=${sceneId}` : 'kind=video', onChanged)
  const changed = () => { load(); if (onChanged) onChanged() }
  const perSecond = pipeline?.spend?.prices?.videoPerSecond ?? 0.15

  async function make(shot) {
    const seconds = [4, 6, 8].find((s) => s >= Math.round(shot.durationSec)) ?? 8
    if (!window.confirm(`Make a ${seconds}-second video take for shot ${shot.number}? Estimated cost about ${usd(seconds * perSecond)}.`)) return
    const r = await call(`${api}/${projectId}/generate`, 'POST', { kind: 'video', targetIds: [shot.id] })
    setMessage(r.ok ? { tone: 'ok', text: 'Started. Video takes a few minutes — you can leave this screen.' } : { tone: 'bad', text: r.data.error })
    changed()
  }

  return (
    <div className="pipe-panel">
      <SceneSelect scenes={scenes} sceneId={sceneId} onChange={onSceneChange} />
      <Notice message={message} />
      <p className="dossier-fine-print">Video is made from the approved shot picture. Make a few takes, watch them, and approve the one you want.</p>
      {sceneId && shots.length === 0 && <p className="dossier-empty">This scene has no shots yet.</p>}
      <ol className="pipe-shots">
        {shots.map((s) => {
          const frame = gens.find((g) => g.shotId === s.id && g.kind === 'keyframe' && g.review === 'approved')
          const takes = gens.filter((g) => g.shotId === s.id && g.kind === 'video')
          return (
            <li key={s.id} className="pipe-shot">
              <div className="pipe-shot-head"><strong>{s.number}</strong> <span className="dossier-code">{s.code}</span> <span className="pipe-shot-camera">{s.durationSec}s</span></div>
              <p>{s.storyboardText || s.description}</p>
              <div className="pipe-card-buttons">
                {frame ? <img className="pipe-thumb" src={`${backendUrl}${frame.mediaUrl}`} alt={`Approved picture for shot ${s.number}`} /> : <span className="dossier-fine-print">No approved shot picture yet (make and approve one first).</span>}
                <button type="button" className="dossier-small-button" disabled={!frame || takes.some((g) => g.status === 'running')} onClick={() => make(s)}>{takes.length ? 'Make another take' : 'Make video take'}</button>
              </div>
              {takes.length > 0 && <div className="pipe-grid pipe-grid-wide">{takes.map((g) => <GenCard key={g.id} g={g} backendUrl={backendUrl} api={api} projectId={projectId} onChanged={changed} label={`Take ${g.version}`} />)}</div>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 8: assemble and export
// ---------------------------------------------------------------------------

export function ExportPanel({ projectId, api, backendUrl, sceneId, onSceneChange }) {
  const scenes = useScenes(api, projectId)
  const [plan, setPlan] = useState(null)
  const [exportsList, setExportsList] = useState([])
  const [message, setMessage] = useState(null)
  const [scope, setScope] = useState('scene')
  const target = scope === 'scene' ? sceneId : null

  const loadPlan = useCallback(async () => {
    const r = await call(`${api}/${projectId}/export/plan${target ? `?sceneId=${target}` : ''}`)
    if (r.ok) setPlan(r.data)
  }, [api, projectId, target])
  const loadExports = useCallback(async () => {
    const r = await call(`${api}/${projectId}/exports`)
    if (r.ok) setExportsList(r.data.exports)
    return r.ok ? r.data.exports : []
  }, [api, projectId])
  useEffect(() => { loadPlan(); loadExports() }, [loadPlan, loadExports])
  const running = exportsList.some((e) => e.status === 'running')
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(loadExports, 3000)
    return () => clearInterval(timer)
  }, [running, loadExports])

  async function start() {
    const r = await call(`${api}/${projectId}/export`, 'POST', { sceneId: target })
    setMessage(r.ok ? { tone: 'ok', text: 'Assembling… this can take a minute or two.' } : { tone: 'bad', text: r.data.error })
    loadExports()
  }

  return (
    <div className="pipe-panel">
      <div className="pipe-toolbar">
        <label className="dossier-field pipe-inline">What to assemble
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="scene">One scene</option>
            <option value="all">The whole film</option>
          </select>
        </label>
        {scope === 'scene' && <SceneSelect scenes={scenes} sceneId={sceneId} onChange={onSceneChange} />}
      </div>
      {plan && (
        <div className="pipe-plan">
          <p>{plan.usable} of {plan.shots} shots have an approved video take or picture.</p>
          {plan.gaps.length > 0 && <details><summary>{plan.gaps.length} things are still missing</summary><ul>{plan.gaps.slice(0, 80).map((g) => <li key={g}>{g}</li>)}</ul></details>}
          {!plan.ffmpeg && <p className="dossier-bad">The video-joining program is not installed on the server, so only the edit package (list + files) can be made.</p>}
        </div>
      )}
      <Notice message={message} />
      <button type="button" className="dossier-small-button" disabled={running || !plan || plan.usable === 0 || (scope === 'scene' && !sceneId)} onClick={start}>Assemble</button>
      <h3>Exports</h3>
      {exportsList.length === 0 ? <p className="dossier-empty">Nothing exported yet.</p> : (
        <ul className="pipe-items">
          {exportsList.map((e) => (
            <li key={e.id} className="pipe-item">
              <strong>{e.sceneCode ? `Scene ${e.sceneCode}` : 'Whole film'}</strong> <span className="dossier-fine-print">{new Date(e.createdAt).toLocaleString()}</span>{' '}
              {e.status === 'running' && <span className="dossier-badge">Assembling…</span>}
              {e.status === 'failed' && <span className="dossier-bad" role="alert">{e.error}</span>}
              {e.status === 'ready' && (
                <>
                  {e.manifest?.gaps?.length > 0 && <span className="dossier-badge stale">{e.manifest.gaps.length} gaps</span>}
                  {e.note && <p className="dossier-fine-print">{e.note}</p>}
                  {e.videoUrl && <video className="pipe-media" controls preload="metadata" src={`${backendUrl}${e.videoUrl}`} />}
                  <p>
                    {e.videoUrl && <a className="dossier-link" href={`${backendUrl}${e.videoUrl}`} target="_blank" rel="noreferrer">Open the video</a>}{' '}
                    {e.packageUrl && <a className="dossier-link" href={`${backendUrl}${e.packageUrl}`}>Download the edit package (.zip)</a>}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
