// Video Studio and Audio Studio.
//   Video  one slot per planned shot. A take can only be made from that shot's APPROVED first frame, and only when you press
//          the button (never automatically after a picture is made). Takes wait for review; the approved take drives the Timeline.
//   Audio  spoken lines (Dialogue / Voice) tied to their line id, speaker, shot and timing; sound effects and music are cues
//          attached to shots. There is no sound-effect or music generator in Filmybase, so those cues use files you attach.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PromptCard } from './Blueprint.jsx'
import { useLive } from './useLive.js'
import './Production.css'
import './Studio.css'

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
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`
const STATE = { planned: ['Planned', ''], blocked: ['Waiting for its first frame', 'warn'], generating: ['Generating…', 'busy'], ready_for_review: ['Ready for review', 'review'], approved: ['Approved', 'ok'], failed: ['Failed', 'bad'] }
function StateBadge({ state, stale }) {
  const [label, cls] = STATE[state] ?? STATE.planned
  return (
    <span className="is-badges">
      <span className={`is-state ${cls}`}><span aria-hidden="true">{{ ok: '✓', bad: '✕', review: '●', busy: '…', warn: '⏸' }[cls] ?? '○'}</span> {label}</span>
      {stale && <span className="is-state stale" title="Made from an older prompt, or from a first frame that has since been replaced.">⚠ Out of date</span>}
    </span>
  )
}

function Player({ url, kind, backendUrl, label, poster }) {
  if (!url) return null
  const src = `${backendUrl}${url}`
  return kind === 'audio'
    ? <audio className="va-audio" controls preload="none" src={src} aria-label={label} />
    : <video className="is-pic" controls preload="metadata" src={src} poster={poster ? `${backendUrl}${poster}` : undefined} aria-label={label} />
}

function useSceneNav(api, projectId, path) {
  const [scenes, setScenes] = useState(null)
  const [sceneId, setSceneId] = useState(null)
  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/studio/${path}/scenes`)
    if (r.ok) setScenes(r.data.scenes)
  }, [api, projectId, path])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (scenes && !scenes.some((s) => s.dbId === sceneId) && scenes[0]) setSceneId(scenes[0].dbId) }, [scenes, sceneId])
  return { scenes, sceneId, setSceneId, reloadScenes: load }
}

function SceneList({ scenes, sceneId, onPick, detail }) {
  return (
    <nav className="is-scenes" aria-label="Scenes">
      {scenes.map((s) => (
        <button key={s.code} type="button" className={`is-scene${s.dbId === sceneId ? ' active' : ''}`} aria-current={s.dbId === sceneId ? 'true' : undefined} onClick={() => onPick(s.dbId)}>
          <strong>Scene {s.number}</strong><span>{detail(s)}</span>
        </button>
      ))}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Video Studio
// ---------------------------------------------------------------------------

function TakeCard({ v, backendUrl, label, onReview, busy, frame }) {
  return (
    <div className="is-waiting">
      <p><strong>Take {v.version}</strong> · {v.seconds ?? '?'} s{v.promptCurrent === false ? ' · made from an older prompt' : ''}{v.outdated ? ' · made from an earlier first frame' : ''}</p>
      <Player url={v.mediaUrl} kind="video" backendUrl={backendUrl} label={`${label} take ${v.version}`} poster={frame?.mediaUrl} />
      <div className="pipe-card-buttons">
        <button type="button" className="dossier-small-button studio-approve" disabled={busy} onClick={() => onReview(v.id, 'approve')}>Approve this take</button>
        <button type="button" className="dossier-small-button" disabled={busy} onClick={() => onReview(v.id, 'reject')}>Reject</button>
      </div>
    </div>
  )
}

export function VideoStudio({ projectId, backendUrl, onNavigate }) {
  const api = `${backendUrl}/api/production`
  const { scenes, sceneId, setSceneId, reloadScenes } = useSceneNav(api, projectId, 'video')
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [seconds, setSeconds] = useState({})
  const [confirmAll, setConfirmAll] = useState(false)
  const loadSlots = useCallback(async () => {
    if (!sceneId) return
    const r = await call(`${api}/${projectId}/studio/video?sceneId=${sceneId}`)
    if (r.ok) setData(r.data)
  }, [api, projectId, sceneId])
  useEffect(() => { setData(null); loadSlots() }, [loadSlots])
  const refresh = useCallback(() => { reloadScenes(); loadSlots() }, [reloadScenes, loadSlots])
  useLive(projectId, backendUrl, refresh)
  async function make(ids, durationSec) {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/generate`, 'POST', { kind: 'video', targetIds: ids, ...(durationSec ? { durationSec } : {}) })
    setBusy(false); setConfirmAll(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Could not start.' })
    else setMessage({ tone: 'good', text: `Started ${r.data.started.length} video take${r.data.started.length === 1 ? '' : 's'}. Videos take a few minutes.${r.data.skipped?.length ? ` ${r.data.skipped.length} skipped.` : ''}` })
    refresh()
  }
  async function review(id, decision) {
    setBusy(true)
    const r = await call(`${api}/${projectId}/generations/${id}/review`, 'POST', { decision })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error }); else refresh()
  }
  if (!scenes) return <p className="dossier-note">Loading…</p>
  if (scenes.length === 0) return <p className="dossier-note">No shots are planned yet. Plan and approve the Blueprint first.</p>
  const ready = (data?.slots ?? []).filter((s) => s.readiness.ok && s.state !== 'approved' && !s.running && !s.latestReady)
  return (
    <div className="is-frames">
      <SceneList scenes={scenes} sceneId={sceneId} onPick={setSceneId} detail={(s) => `${s.approved}/${s.shots} approved${s.review ? ` · ${s.review} to review` : ''}${s.blocked ? ` · ${s.blocked} need a first frame` : ''}`} />
      <div className="is-slots">
        {!data && <p className="dossier-note">Loading…</p>}
        {data && (
          <>
            <div className="is-toolbar">
              <p className="is-counts"><strong>{data.counts.shots}</strong> shots · <strong>{data.counts.approved}</strong> with an approved video · {data.counts.review} take{data.counts.review === 1 ? '' : 's'} to review · {data.counts.readyToMake} ready to make · {data.counts.blocked} waiting for a first frame</p>
              {ready.length > 0 && !confirmAll && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => setConfirmAll(true)}>Make videos for the {ready.length} ready shot{ready.length === 1 ? '' : 's'}…</button>}
              {confirmAll && <span className="is-confirm" role="alert">Video is the most expensive step: about {usd(ready.reduce((n, s) => n + s.estimateUsd, 0))} for {ready.length} shot{ready.length === 1 ? '' : 's'}. <button type="button" className="dossier-small-button studio-approve" disabled={busy} onClick={() => make(ready.map((s) => s.dbId))}>Yes, make them</button><button type="button" className="dossier-small-button" onClick={() => setConfirmAll(false)}>Cancel</button></span>}
            </div>
            <p className="dossier-fine-print">Nothing here starts by itself: finishing or approving a picture never starts a video. Every job is checked against the money limit first.</p>
            {message && <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>{message.text}</p>}
            <ul className="is-grid is-grid-wide">
              {data.slots.map((s) => {
                const chosen = seconds[s.dbId] ?? s.targetSeconds
                return (
                  <li key={s.dbId} className={`is-card ${s.state}`}>
                    <header className="is-card-head"><strong>{s.shotId}</strong><span className="dossier-fine-print">planned {secs(s.plannedDurationMs)}{s.cameraMove && s.cameraMove !== 'Static' ? ` · ${s.cameraMove}` : ''}</span><StateBadge state={s.state} stale={s.stale} /></header>
                    <p className="is-action">{s.action}</p>
                    {s.canonical
                      ? <Player url={s.canonical.mediaUrl} kind="video" backendUrl={backendUrl} label={`Approved video of ${s.shotId}`} poster={s.firstFrame?.mediaUrl} />
                      : s.firstFrame ? <img className="is-pic" src={`${backendUrl}${s.firstFrame.mediaUrl}`} alt={`Approved first frame of ${s.shotId}`} loading="lazy" /> : <div className="is-empty">No approved first frame yet</div>}
                    <p className="dossier-fine-print">{s.canonical ? 'Approved video (this is what the Timeline plays).' : s.firstFrame ? 'Approved first frame — the video will start from this picture.' : ''}</p>
                    {!s.readiness.ok && <p className="dossier-fine-print">{s.readiness.reason} <button type="button" className="dossier-small-button" onClick={() => onNavigate?.('imageStudio')}>Open Image Studio</button></p>}
                    <div className="pipe-card-buttons">
                      <label className="va-seconds">Length
                        <select value={chosen} onChange={(e) => setSeconds({ ...seconds, [s.dbId]: Number(e.target.value) })} disabled={busy || s.running}>
                          {s.allowedSeconds.map((x) => <option key={x} value={x}>{x} s{x === s.targetSeconds ? ' (planned)' : ''}</option>)}
                        </select>
                      </label>
                      <button type="button" className="dossier-small-button" disabled={busy || s.running || !s.readiness.ok} onClick={() => make([s.dbId], chosen)}>{s.running ? 'Generating…' : s.versions > 0 ? `Make another take (${usd(s.estimateUsd)})` : `Generate video (${usd(s.estimateUsd)})`}</button>
                    </div>
                    {s.latestReady && <TakeCard v={s.latestReady} backendUrl={backendUrl} label={s.shotId} onReview={review} busy={busy} frame={s.firstFrame} />}
                    {s.history.length > 0 && (
                      <details className="is-history"><summary>Other takes ({s.history.length})</summary>
                        <ul>{s.history.map((v) => (
                          <li key={v.id}>
                            <span>take {v.version} · {v.seconds ?? '?'} s · {v.status === 'failed' ? `failed${v.error ? `: ${v.error}` : ''}` : v.review === 'rejected' ? 'rejected' : v.status === 'running' ? 'generating' : 'not chosen'}</span>
                            {v.mediaUrl && <Player url={v.mediaUrl} kind="video" backendUrl={backendUrl} label={`${s.shotId} take ${v.version}`} />}
                            {v.status === 'ready' && v.review !== 'approved' && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => review(v.id, 'approve')}>Make this the approved one</button>}
                          </li>))}</ul>
                      </details>
                    )}
                    {s.prompt && (
                      <details className="is-prompt"><summary>Video prompt (v{s.prompt.version}{s.prompt.edited ? ', edited' : ''}){s.prompt.stale ? ' — out of date' : ''}</summary>
                        <ul className="bp-prompts"><PromptCard p={{ ...s.prompt, purpose: 'video', shotId: s.dbId }} label={`${s.shotId} video`} api={api} projectId={projectId} onSaved={refresh} /></ul>
                      </details>
                    )}
                    {s.characterIds.length + s.environmentIds.length > 0 && <p className="dossier-fine-print">Continuity: keep {[...s.characterIds, ...s.environmentIds, ...s.propIds].join(', ')} looking the same as in the first frame.</p>}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Audio Studio
// ---------------------------------------------------------------------------

function Dialogue({ projectId, backendUrl }) {
  const api = `${backendUrl}/api/production`
  const { scenes, sceneId, setSceneId, reloadScenes } = useSceneNav(api, projectId, 'audio')
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const loadLines = useCallback(async () => {
    if (!sceneId) return
    const r = await call(`${api}/${projectId}/studio/audio?sceneId=${sceneId}`)
    if (r.ok) setData(r.data)
  }, [api, projectId, sceneId])
  useEffect(() => { setData(null); loadLines() }, [loadLines])
  const refresh = useCallback(() => { reloadScenes(); loadLines() }, [reloadScenes, loadLines])
  useLive(projectId, backendUrl, refresh)
  async function make(ids) {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/generate`, 'POST', { kind: 'audio', targetIds: ids })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Could not start.' })
    else setMessage({ tone: 'good', text: `Started ${r.data.started.length} voice${r.data.started.length === 1 ? '' : 's'}.` })
    refresh()
  }
  async function review(id, decision) {
    setBusy(true)
    const r = await call(`${api}/${projectId}/generations/${id}/review`, 'POST', { decision })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error }); else refresh()
  }
  if (!scenes) return <p className="dossier-note">Loading…</p>
  if (scenes.length === 0) return <p className="dossier-note">There are no spoken lines yet. Approve the screenplay and the Blueprint first.</p>
  const todo = (data?.lines ?? []).filter((l) => l.state === 'planned' || l.state === 'failed')
  return (
    <div className="is-frames">
      <SceneList scenes={scenes} sceneId={sceneId} onPick={setSceneId} detail={(s) => `${s.approved}/${s.lines} voices approved${s.review ? ` · ${s.review} to review` : ''}`} />
      <div className="is-slots">
        {!data && <p className="dossier-note">Loading…</p>}
        {data && (
          <>
            <div className="is-toolbar">
              <p className="is-counts"><strong>{data.counts.lines}</strong> spoken lines · <strong>{data.counts.approved}</strong> approved · {data.counts.review} to review{data.counts.overflowing ? ` · ${data.counts.overflowing} longer than their shot` : ''}</p>
              {todo.length > 0 && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => make(todo.map((l) => l.dbId))}>Make the {todo.length} missing voice{todo.length === 1 ? '' : 's'} (≈{usd(data.counts.estimateUsd)})</button>}
            </div>
            {message && <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>{message.text}</p>}
            <ul className="is-grid is-grid-wide">
              {data.lines.map((l) => (
                <li key={l.dbId} className={`is-card ${l.state}`}>
                  <header className="is-card-head"><strong>{l.lineId} · {l.speaker}</strong><span className="dossier-fine-print">{l.shotId ?? 'not in a shot'} · voice {l.voice ?? '—'}</span><StateBadge state={l.state} stale={l.stale} /></header>
                  <p className="va-line">{l.parenthetical ? <em>{l.parenthetical} </em> : null}“{l.text}”</p>
                  <p className="dossier-fine-print">Timing: starts {secs(l.timing.offsetMs)} into its shot · shot is {l.timing.shotMs ? secs(l.timing.shotMs) : '—'} · voice {l.timing.audioMs ? secs(l.timing.audioMs) : `about ${l.timing.plannedMs ? secs(l.timing.plannedMs) : '—'} (planned)`}</p>
                  {!l.timing.fits && <p className="dossier-error" role="alert">The approved voice runs {secs(l.timing.overflowMs)} past the end of its shot. Lengthen the shot in the Blueprint or shorten the line.</p>}
                  {l.lipSync && <p className="dossier-fine-print va-lip">⚠ {l.lipSync}</p>}
                  {l.canonical && <><Player url={l.canonical.mediaUrl} kind="audio" backendUrl={backendUrl} label={`Approved voice for ${l.lineId}`} /><p className="dossier-fine-print">Approved voice (on the Timeline's dialogue track).</p></>}
                  {l.latestReady && (
                    <div className="is-waiting">
                      <p><strong>Version {l.latestReady.version}</strong> is ready — not used until you approve it.</p>
                      <Player url={l.latestReady.mediaUrl} kind="audio" backendUrl={backendUrl} label={`New voice for ${l.lineId}, waiting for review`} />
                      <div className="pipe-card-buttons"><button type="button" className="dossier-small-button studio-approve" disabled={busy} onClick={() => review(l.latestReady.id, 'approve')}>Approve this one</button><button type="button" className="dossier-small-button" disabled={busy} onClick={() => review(l.latestReady.id, 'reject')}>Reject</button></div>
                    </div>
                  )}
                  <div className="pipe-card-buttons"><button type="button" className="dossier-small-button" disabled={busy || l.running} onClick={() => make([l.dbId])}>{l.running ? 'Generating…' : l.versions > 0 ? `Make another version (${usd(l.estimateUsd)})` : `Generate voice (${usd(l.estimateUsd)})`}</button></div>
                  {l.history.length > 0 && (
                    <details className="is-history"><summary>Other versions ({l.history.length})</summary>
                      <ul>{l.history.map((v) => <li key={v.id}><span>v{v.version} · {v.status === 'failed' ? `failed${v.error ? `: ${v.error}` : ''}` : v.review === 'rejected' ? 'rejected' : 'not chosen'}</span>{v.mediaUrl && <Player url={v.mediaUrl} kind="audio" backendUrl={backendUrl} label={`${l.lineId} version ${v.version}`} />}{v.status === 'ready' && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => review(v.id, 'approve')}>Make this the approved one</button>}</li>)}</ul>
                    </details>
                  )}
                  {l.prompt && <details className="is-prompt"><summary>Audio instruction (v{l.prompt.version}{l.prompt.edited ? ', edited' : ''}){l.prompt.stale ? ' — out of date' : ''}</summary><ul className="bp-prompts"><PromptCard p={{ ...l.prompt, purpose: 'audio', elementId: l.dbId }} label={`${l.lineId} voice`} api={api} projectId={projectId} onSaved={refresh} /></ul></details>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

function Cues({ kind, projectId, backendUrl }) {
  const api = `${backendUrl}/api/production`
  const [cues, setCues] = useState(null)
  const [shots, setShots] = useState([])
  const [form, setForm] = useState({ label: '', prompt: '', shotId: '', offset: '0', duration: '2' })
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const [c, m] = await Promise.all([call(`${api}/${projectId}/audio-cues`), call(`${api}/${projectId}/manifest`)])
    if (c.ok) setCues(c.data.cues)
    if (m.ok) setShots(m.data.shots.map((s) => ({ id: s.db_id, ref: s.shot_id, action: s.action })))
  }, [api, projectId])
  useEffect(() => { load() }, [load])
  useLive(projectId, backendUrl, load)
  const mine = useMemo(() => (cues ?? []).filter((c) => c.kind === kind), [cues, kind])
  const title = kind === 'sfx' ? 'sound effect' : 'music'
  async function add(e) {
    e.preventDefault()
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/audio-cues`, 'POST', { kind, label: form.label, prompt: form.prompt, shotId: form.shotId ? Number(form.shotId) : null, offsetMs: Math.round(Number(form.offset) * 1000), durationMs: Math.round(Number(form.duration) * 1000) })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error }); else { setForm({ ...form, label: '', prompt: '' }); load() }
  }
  async function attach(cue, file) {
    if (!file) return
    setBusy(true); setMessage(null)
    const dataBase64 = await new Promise((resolve) => { const reader = new FileReader(); reader.onloadend = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file) })
    const r = await call(`${api}/${projectId}/audio-cues/${cue.id}/media`, 'POST', { filename: file.name, dataBase64 })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error }); else load()
  }
  async function act(url, method, body) {
    setBusy(true)
    const r = await call(url, method, body)
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error }); else load()
  }
  if (!cues) return <p className="dossier-note">Loading…</p>
  return (
    <div className="pipe-panel">
      <p className="dossier-fine-print">Filmybase has <strong>no {title} generator</strong>. Plan each cue here (what it should sound like, which shot, when it starts), then attach a .wav, .mp3, .m4a or .ogg file and approve it. Planned cues already appear on the Timeline's {kind === 'sfx' ? 'sound-effects' : 'music'} track.</p>
      <form className="va-cue-form" onSubmit={add}>
        <label>Name<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={kind === 'sfx' ? 'Door slam' : 'Tense strings'} required /></label>
        <label>Shot<select value={form.shotId} onChange={(e) => setForm({ ...form, shotId: e.target.value })}><option value="">Not tied to a shot</option>{shots.map((s) => <option key={s.id} value={s.id}>{s.ref} — {String(s.action).slice(0, 40)}</option>)}</select></label>
        <label>Starts (seconds into the shot)<input type="number" min="0" step="0.1" value={form.offset} onChange={(e) => setForm({ ...form, offset: e.target.value })} /></label>
        <label>Length (seconds)<input type="number" min="0.2" step="0.1" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} /></label>
        <label className="va-wide">What it should sound like<input value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} /></label>
        <button type="submit" className="dossier-small-button" disabled={busy || !form.label.trim()}>Add the {title} cue</button>
      </form>
      {message && <p className="dossier-error" role="alert">{message.text}</p>}
      {mine.length === 0 && <p className="dossier-note">No {title} cues yet.</p>}
      <ul className="is-grid is-grid-wide">
        {mine.map((c) => (
          <li key={c.id} className={`is-card ${c.state}`}>
            <header className="is-card-head"><strong>{c.label}</strong><span className="dossier-fine-print">{c.shotId ?? 'no shot'} · +{secs(c.offsetMs)} · {secs(c.durationMs)}</span><StateBadge state={c.state === 'planned' ? 'planned' : c.state} /></header>
            {c.prompt && <p className="is-action">{c.prompt}</p>}
            {c.mediaUrl && <Player url={c.mediaUrl} kind="audio" backendUrl={backendUrl} label={`${c.label} sound`} />}
            <div className="pipe-card-buttons">
              <label className="dossier-small-button va-file">{c.mediaUrl ? 'Replace the file' : 'Attach a sound file'}<input type="file" accept=".wav,.mp3,.m4a,.ogg,audio/*" hidden disabled={busy} onChange={(e) => attach(c, e.target.files?.[0])} /></label>
              {c.mediaUrl && !c.approved && <button type="button" className="dossier-small-button studio-approve" disabled={busy} onClick={() => act(`${api}/${projectId}/audio-cues/${c.id}/approval`, 'POST', { approved: true })}>Approve</button>}
              {c.approved && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => act(`${api}/${projectId}/audio-cues/${c.id}/approval`, 'POST', { approved: false })}>Un-approve</button>}
              <button type="button" className="dossier-small-button" disabled={busy} onClick={() => act(`${api}/${projectId}/audio-cues/${c.id}`, 'DELETE')}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AudioStudio({ projectId, backendUrl }) {
  const [tab, setTab] = useState('dialogue')
  return (
    <div className="is">
      <nav className="dossier-tabs is-tabs" aria-label="Audio Studio areas">
        {[['dialogue', 'Dialogue / Voice'], ['sfx', 'Sound Effects'], ['music', 'Music']].map(([k, label]) => <button key={k} type="button" className={tab === k ? 'dossier-tab active' : 'dossier-tab'} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}</button>)}
      </nav>
      {tab === 'dialogue' ? <Dialogue projectId={projectId} backendUrl={backendUrl} /> : <Cues key={tab} kind={tab} projectId={projectId} backendUrl={backendUrl} />}
    </div>
  )
}
