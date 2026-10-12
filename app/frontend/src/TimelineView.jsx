// The Timeline workspace. It exists from the moment the Production Blueprint is approved: one labelled block per shot,
// sized by its planned length, before any image, video or voice exists. Approved media replaces the placeholder by
// itself (the page listens for live updates); media that is only generated waits for review and never replaces it.
// What this screen shows is derived by the server from approved media — it never stores a second copy.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLive } from './useLive.js'
import TimelineEditBar from './TimelineEditBar.jsx'
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

export const fmtTime = (ms) => {
  const total = Math.max(0, Math.round(ms / 100) / 10)
  const m = Math.floor(total / 60)
  const s = (total - m * 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}
const STATE_LABEL = { planned: 'Planned', first_frame: 'First frame approved', video: 'Video approved', audio: 'Audio approved' }
const STATE_ICON = { planned: '○', first_frame: '▣', video: '▶', audio: '♪' }

function Clip({ c, scale, selected, onSelect, backendUrl }) {
  const left = c.startMs * scale
  const width = Math.max(14, c.durationMs * scale)
  const thumb = c.kind === 'shot' ? (c.frame?.url ?? (c.media?.type === 'image' ? c.media.url : null)) : null
  const review = Object.values(c.reviewNeeded ?? {}).reduce((a, b) => a + b, 0)
  return (
    <button
      type="button"
      data-clip-id={c.id}
      className={`tl-clip tl-${c.kind} state-${c.state}${selected ? ' selected' : ''}${c.orphaned ? ' orphaned' : ''}`}
      style={{ left, width, backgroundImage: thumb ? `linear-gradient(rgba(0,0,0,.25), rgba(0,0,0,.55)), url(${backendUrl}${thumb})` : undefined }}
      onClick={() => onSelect(c.id)}
      aria-pressed={selected}
      aria-label={`${c.label}. ${STATE_LABEL[c.state]}. ${fmtTime(c.startMs)} to ${fmtTime(c.startMs + c.durationMs)}.${review ? ` ${review} waiting for review.` : ''}${c.orphaned ? ' Removed from the Blueprint.' : ''}`}
      title={c.label}
    >
      <span className="tl-clip-icon" aria-hidden="true">{STATE_ICON[c.state]}</span>
      <span className="tl-clip-label">{c.kind === 'shot' ? (width < 110 ? (c.shotRef ?? '').replace(/^SC\d+_/, '') : c.shotRef) : c.label}</span>
      {review > 0 && <span className="tl-clip-review" aria-hidden="true">●</span>}
    </button>
  )
}

function Monitor({ clip, backendUrl }) {
  if (!clip) return <div className="tl-monitor empty">Choose a block on the timeline.</div>
  if (clip.state === 'video' && clip.media?.url) return <video key={clip.media.url} className="tl-monitor-media" controls preload="metadata" src={`${backendUrl}${clip.media.url}`} poster={clip.frame ? `${backendUrl}${clip.frame.url}` : undefined} />
  if (clip.state === 'audio' && clip.media?.url) return <div className="tl-monitor audio"><p>{clip.label}</p><audio controls preload="metadata" src={`${backendUrl}${clip.media.url}`} /></div>
  if (clip.state === 'first_frame' && clip.media?.url) return <div className="tl-monitor"><img className="tl-monitor-media" src={`${backendUrl}${clip.media.url}`} alt={`Approved first frame of ${clip.shotRef}`} /><p className="tl-monitor-note">Approved first frame. Video not made yet — its prompt is under “Video prompt”.</p></div>
  return (
    <div className="tl-monitor planned">
      <p className="tl-monitor-title">{clip.kind === 'shot' ? clip.shotRef : clip.label} · planned</p>
      {clip.kind === 'shot' && <p className="tl-monitor-note">No picture or video has been approved yet. Here is what will be asked for:</p>}
      {clip.imagePrompt && <details open><summary>Image prompt (v{clip.imagePrompt.version})</summary><p>{clip.imagePrompt.text}</p></details>}
      {clip.videoPrompt && <details open><summary>Video prompt (v{clip.videoPrompt.version})</summary><p>{clip.videoPrompt.text}</p></details>}
      {clip.kind === 'dialogue' && <p className="tl-monitor-note">No voice approved yet. Make it in the Audio Studio.</p>}
    </div>
  )
}

function Inspector({ clip, api, projectId, backendUrl, onNavigate, onEdit }) {
  const [tab, setTab] = useState('preview')
  const [details, setDetails] = useState(null)
  useEffect(() => { setDetails(null) }, [clip?.id])
  useEffect(() => {
    if (tab !== 'details' || !clip || details) return
    let cancelled = false
    ;(async () => {
      const q = clip.kind === 'shot' ? `shotId=${clip.shotId}` : `elementId=${clip.elementId}`
      const g = await call(`${api}/${projectId}/generations?${q}`)
      const p = clip.kind === 'shot' ? await Promise.all(['first_frame', 'video'].map((purpose) => call(`${api}/${projectId}/blueprint/prompts/history?purpose=${purpose}&shotId=${clip.shotId}`))) : []
      if (!cancelled) setDetails({ generations: g.ok ? g.data.generations : [], prompts: p.map((r, i) => ({ purpose: ['first_frame', 'video'][i], versions: r.ok ? r.data.versions : [] })) })
    })()
    return () => { cancelled = true }
  }, [tab, clip, details, api, projectId])
  if (!clip) return <aside className="tl-inspector"><p className="dossier-note">Nothing selected.</p></aside>
  const review = Object.values(clip.reviewNeeded ?? {}).reduce((a, b) => a + b, 0)
  const tabs = clip.kind === 'shot' ? ['preview', 'image', 'video', 'details'] : ['preview', 'details']
  return (
    <aside className="tl-inspector" aria-label="Inspector">
      <header className="tl-inspector-head">
        <h3>{clip.kind === 'shot' ? clip.shotRef : clip.label}</h3>
        <span className={`tl-state state-${clip.state}`}>{STATE_ICON[clip.state]} {STATE_LABEL[clip.state]}</span>
        {clip.orphaned && <span className="dossier-badge stale">Removed from the Blueprint</span>}
      </header>
      {clip.action && <p className="tl-action">{clip.action}</p>}
      <dl className="tl-durations">
        <div><dt>Planned</dt><dd>{fmtTime(clip.plannedDurationMs)}</dd></div>
        <div><dt>Source</dt><dd>{clip.sourceDurationMs ? fmtTime(clip.sourceDurationMs) : '—'}</dd></div>
        <div><dt>On timeline</dt><dd>{fmtTime(clip.durationMs)}</dd></div>
        <div><dt>Starts</dt><dd>{fmtTime(clip.startMs)}</dd></div>
      </dl>
      {clip.flags?.sourceTooShort && <p className="dossier-error" role="alert">The made clip is shorter than the time reserved for it on the timeline.</p>}
      {review > 0 && (
        <p className="tl-review" role="status">
          {review} {review === 1 ? 'result is' : 'results are'} generated and waiting for your approval — it will not replace this block until you approve it.
          <button type="button" className="dossier-small-button" onClick={() => onNavigate?.(clip.kind === 'dialogue' ? 'audioStudio' : clip.reviewNeeded.video ? 'videoStudio' : 'imageStudio')}>Review it</button>
        </p>
      )}
      <nav className="dossier-tabs" aria-label="Inspector sections">
        {tabs.map((t) => <button key={t} type="button" className={tab === t ? 'dossier-tab active' : 'dossier-tab'} onClick={() => setTab(t)}>{{ preview: 'Preview', image: 'Image prompt', video: 'Video prompt', details: 'Details & history' }[t]}</button>)}
      </nav>
      {tab === 'preview' && <Monitor clip={clip} backendUrl={backendUrl} />}
      {tab === 'image' && (clip.imagePrompt ? <div className="tl-prompt"><p className="dossier-fine-print">First-frame prompt, version {clip.imagePrompt.version}</p><p>{clip.imagePrompt.text}</p></div> : <p className="dossier-note">No image prompt yet.</p>)}
      {tab === 'video' && (clip.videoPrompt ? <div className="tl-prompt"><p className="dossier-fine-print">Video prompt, version {clip.videoPrompt.version}</p><p>{clip.videoPrompt.text}</p></div> : <p className="dossier-note">No video prompt yet.</p>)}
      {tab === 'details' && (
        <div className="tl-details">
          {!details && <p className="dossier-note">Loading…</p>}
          {details?.prompts.map((p) => (
            <details key={p.purpose}><summary>{p.purpose === 'first_frame' ? 'Image prompt' : 'Video prompt'} history ({p.versions.length})</summary>
              <ol className="bp-history">{p.versions.map((v) => <li key={v.id}><strong>v{v.version}</strong> {v.status === 'current' ? '(current)' : ''}<p>{v.text}</p></li>)}</ol>
            </details>
          ))}
          {details && (
            <details open><summary>Everything made for this block ({details.generations.length})</summary>
              {details.generations.length === 0 && <p className="dossier-note">Nothing has been generated yet.</p>}
              <ul className="tl-gens">{details.generations.map((g) => (
                <li key={g.id}>
                  <strong>{g.kind} v{g.version}</strong> · {g.status === 'ready' ? (g.review === 'approved' ? 'approved' : g.review === 'rejected' ? 'rejected' : 'ready for review') : g.status}
                  {g.costUsd ? ` · $${g.costUsd.toFixed(2)}` : ''}{g.error ? ` · ${g.error}` : ''}
                  {g.kind === 'video' && g.status === 'ready' && g.review !== 'rejected' && clip.kind === 'shot' && (
                    <button type="button" className="dossier-small-button" onClick={() => onEdit?.({ type: 'take', clipId: clip.id, generationId: g.id })}>Play this take</button>
                  )}
                </li>
              ))}</ul>
            </details>
          )}
        </div>
      )}
    </aside>
  )
}

export { call }
export default function TimelineView({ projectId, backendUrl, onNavigate }) {
  const api = `${backendUrl}/api/production`
  const [tl, setTl] = useState(null)
  const [selected, setSelected] = useState(null)
  const [zoom, setZoom] = useState(24) // pixels per second
  const [playhead, setPlayhead] = useState(0)
  const scroller = useRef(null)
  const [note, setNote] = useState(null)
  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/timeline`)
    if (r.ok) setTl(r.data)
  }, [api, projectId])
  useEffect(() => { load() }, [load])
  const live = useLive(projectId, backendUrl, load)
  async function editOp(op) {
    const r = await call(`${api}/${projectId}/timeline/edit`, 'POST', { op, expectedRevision: tl?.editRevision })
    setNote(r.ok ? { ok: true, text: `Done: ${r.data.label}.` } : { ok: false, text: r.data?.error ?? 'That did not work.' })
    load()
  }
  async function muteSolo(track, patch) {
    await editOp({ type: 'track', trackId: track.id, ...patch })
  }
  async function saveSnapshot() {
    const r = await call(`${api}/${projectId}/timeline/snapshots`, 'POST', { label: '' })
    setNote(r.ok ? { ok: true, text: `Saved timeline version ${r.data.snapshot.version}. Open Export & Delivery to render it.` } : { ok: false, text: r.data?.error ?? 'Could not save.' })
  }
  const scale = zoom / 1000
  const clips = useMemo(() => (tl?.clips ?? []).filter((c) => !c.orphaned || c.media), [tl])
  const shotClips = useMemo(() => clips.filter((c) => c.kind === 'shot').sort((a, b) => a.startMs - b.startMs), [clips])
  useEffect(() => { if (!selected && shotClips[0]) setSelected(shotClips[0].id) }, [shotClips, selected])
  const clip = clips.find((c) => c.id === selected) ?? null

  function selectAt(ms) {
    setPlayhead(ms)
    const hit = shotClips.find((c) => ms >= c.startMs && ms < c.startMs + c.durationMs)
    if (hit) setSelected(hit.id)
  }
  function onKey(e) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const i = Math.max(0, shotClips.findIndex((c) => c.id === selected))
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? shotClips.length - 1 : Math.min(shotClips.length - 1, Math.max(0, i + (e.key === 'ArrowRight' ? 1 : -1)))
    const target = shotClips[next]
    if (target) { setSelected(target.id); setPlayhead(target.startMs); document.querySelector(`[data-clip-id="${target.id}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest' }) }
  }

  if (!tl) return <p className="dossier-note">Loading the timeline…</p>
  if (!tl.exists) {
    return (
      <div className="tl-empty">
        <h3>The timeline starts when the Blueprint is approved</h3>
        <p>Once the shots, lengths and prompts are planned and approved, every shot appears here as a labelled block — before a single picture is made. Approved pictures, videos and voices then fill the blocks in by themselves.</p>
        <button type="button" className="dossier-small-button" onClick={() => onNavigate?.('blueprint')}>Go to the Production Blueprint</button>
      </div>
    )
  }
  const width = Math.max(600, tl.totalMs * scale + 120)
  const step = zoom >= 60 ? 1000 : zoom >= 24 ? 5000 : zoom >= 10 ? 15000 : 60000
  const ticks = Array.from({ length: Math.floor(tl.totalMs / step) + 2 }, (_, i) => i * step)
  const s = tl.summary
  return (
    <div className="tl">
      <header className="tl-top">
        <p className="tl-summary" role="status">
          {s.shots} shots · {fmtTime(tl.totalMs)} · {s.placeholders} still planned · {s.firstFrames} first frames · {s.videos} videos · {s.audio} voices
          {s.reviewNeeded > 0 && <strong className="tl-review-count"> · {s.reviewNeeded} waiting for review</strong>}
        </p>
        <span className={live ? 'tl-live on' : 'tl-live'} title={live ? 'Updating live' : 'Checking for changes every few seconds'}>{live ? '● Live' : '○ Refreshing'}</span>
        <label className="tl-zoom">Zoom <input type="range" min="6" max="120" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Timeline zoom" /></label>
        <span className="tl-time" aria-label="Playhead time">{fmtTime(playhead)}</span>
        <button type="button" className="dossier-small-button" onClick={saveSnapshot} title="Freeze this exact edit as a numbered version that can be exported">Save version</button>
        <button type="button" className="dossier-small-button" onClick={() => onNavigate?.('export')}>Export…</button>
      </header>
      <TimelineEditBar api={api} projectId={projectId} tl={tl} clip={clip} shotClips={shotClips} playhead={playhead} call={call} reload={load} />
      {note && <p className={note.ok ? 'dossier-note' : 'dossier-error'} role={note.ok ? 'status' : 'alert'}>{note.text}</p>}
      <div className="tl-main">
        <Monitor clip={clip} backendUrl={backendUrl} />
        <Inspector clip={clip} api={api} projectId={projectId} backendUrl={backendUrl} onNavigate={onNavigate} onEdit={editOp} />
      </div>
      <div className="tl-scroll" ref={scroller} tabIndex={0} onKeyDown={onKey} role="group" aria-label="Timeline. Use the arrow keys to move between shots.">
        <div className="tl-canvas" style={{ width }}>
          <div className="tl-ruler" onClick={(e) => selectAt((e.clientX - e.currentTarget.getBoundingClientRect().left) / scale)}>
            {ticks.map((t) => <span key={t} className="tl-tick" style={{ left: t * scale }}>{fmtTime(t).replace(/\.\d$/, '')}</span>)}
          </div>
          {tl.tracks.map((track) => (
            <div key={track.id} className={`tl-track tl-track-${track.kind}`}>
              <span className="tl-track-name" title={track.label}>
                {track.name}
                {track.kind !== 'video' && (
                  <span className="tl-track-ms">
                    <button type="button" className={track.muted ? 'on' : ''} aria-pressed={track.muted} aria-label={`Mute ${track.label}`} title="Mute" onClick={() => muteSolo(track, { muted: !track.muted })}>M</button>
                    <button type="button" className={track.solo ? 'on' : ''} aria-pressed={track.solo} aria-label={`Solo ${track.label}`} title="Solo" onClick={() => muteSolo(track, { solo: !track.solo })}>S</button>
                  </span>
                )}
              </span>
              <div className="tl-lane" onClick={(e) => { if (e.target === e.currentTarget) selectAt((e.clientX - e.currentTarget.getBoundingClientRect().left) / scale) }}>
                {clips.filter((c) => c.trackId === track.id).map((c) => <Clip key={c.id} c={c} scale={scale} selected={c.id === selected} onSelect={(id) => { setSelected(id); setPlayhead(c.startMs) }} backendUrl={backendUrl} />)}
              </div>
            </div>
          ))}
          <div className="tl-playhead" style={{ left: playhead * scale }} aria-hidden="true" />
        </div>
      </div>
      <p className="dossier-fine-print tl-legend">○ planned · ▣ first frame approved · ▶ video approved · ♪ audio approved · ● something is waiting for your review. Sound effects and music tracks are ready for cues (Audio Studio).</p>
    </div>
  )
}
