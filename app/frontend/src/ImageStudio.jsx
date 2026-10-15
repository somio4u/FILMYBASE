// Image Studio: four equal areas — Characters, Environments, Properties, Shot Frames.
// Every slot shows ONE canonical (approved) picture; everything else lives in a collapsed history. A new result always waits
// for review and never becomes canonical (or reaches the Timeline) until you approve it. Prompts are written in the Blueprint,
// are one click away here, and every version is kept.

import StylePicker from './StylePicker.jsx'
import { ImportPictures, PropCombiner, OriginControl, ReferenceImages } from './ImageTools.jsx'
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
const STATE = {
  planned: { label: 'Planned', cls: '' }, blocked: { label: 'Waiting for references', cls: 'warn' }, generating: { label: 'Generating…', cls: 'busy' },
  ready_for_review: { label: 'Ready for review', cls: 'review' }, approved: { label: 'Approved', cls: 'ok' }, failed: { label: 'Failed', cls: 'bad' },
}
function StateBadge({ state, stale }) {
  const s = STATE[state] ?? STATE.planned
  return (
    <span className="is-badges">
      <span className={`is-state ${s.cls}`}><span aria-hidden="true">{{ ok: '✓', bad: '✕', review: '●', busy: '…', warn: '⏸' }[s.cls] ?? '○'}</span> {s.label}</span>
      {stale && <span className="is-state stale" title="Made from an older prompt or from a reference that has since been replaced.">⚠ Out of date</span>}
    </span>
  )
}

function Picture({ version, backendUrl, alt, className = '' }) {
  if (!version?.mediaUrl) return null
  return <a href={`${backendUrl}${version.mediaUrl}`} target="_blank" rel="noreferrer"><img className={`is-pic ${className}`} src={`${backendUrl}${version.mediaUrl}`} alt={alt} loading="lazy" /></a>
}

// The version waiting for a decision, and the older versions in a collapsible history.
function Versions({ slot, backendUrl, onReview, busy, label }) {
  const { latestReady, history } = slot
  return (
    <>
      {latestReady && (
        <div className="is-waiting">
          <p><strong>Version {latestReady.version}</strong> is ready — it is not used anywhere until you approve it.{latestReady.promptCurrent === false ? ' (Made from an older prompt.)' : ''}</p>
          <Picture version={latestReady} backendUrl={backendUrl} alt={`${label} version ${latestReady.version}, waiting for review`} />
          <div className="pipe-card-buttons">
            <button type="button" className="dossier-small-button studio-approve" disabled={busy} onClick={() => onReview(latestReady.id, 'approve')}>Approve this one</button>
            <button type="button" className="dossier-small-button" disabled={busy} onClick={() => onReview(latestReady.id, 'reject')}>Reject</button>
          </div>
        </div>
      )}
      {history.length > 0 && (
        <details className="is-history">
          <summary>Other versions ({history.length})</summary>
          <ul>
            {history.map((v) => (
              <li key={v.id}>
                <span>v{v.version} · {v.status === 'failed' ? `failed${v.error ? `: ${v.error}` : ''}` : v.status === 'running' ? 'generating' : v.review === 'rejected' ? 'rejected' : v.review === 'approved' ? 'approved' : 'not chosen'}{v.costUsd ? ` · ${usd(v.costUsd)}` : ''}</span>
                {v.mediaUrl && <Picture version={v} backendUrl={backendUrl} alt={`${label} version ${v.version}`} className="is-thumb" />}
                {v.status === 'ready' && v.review !== 'approved' && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => onReview(v.id, 'approve')}>Make this the approved one</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

function Library({ type, api, projectId, backendUrl }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/studio/assets?type=${type}`)
    if (r.ok) setData(r.data)
  }, [api, projectId, type])
  useEffect(() => { setData(null); load() }, [load])
  useLive(projectId, backendUrl, load)
  // properties (and "other" items such as letters or signs) are all made as props
  const kind = type === 'property' ? 'prop' : type
  async function generate(ids) {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/generate`, 'POST', { kind, targetIds: ids })
    setBusy(false); setConfirmAll(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Could not start.' })
    else setMessage({ tone: 'good', text: `Queued ${r.data.started.length}${r.data.started.length > 1 ? ' — they are made one at a time, the cards fill in as each finishes' : ''}.${r.data.skipped?.length ? ` ${r.data.skipped.length} skipped: ${r.data.skipped[0].reason}` : ''}` })
    load()
  }
  async function review(id, decision) {
    setBusy(true)
    const r = await call(`${api}/${projectId}/generations/${id}/review`, 'POST', { decision })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error }); else load()
  }
  if (!data) return <p className="dossier-note">Loading…</p>
  const c = data.counts
  // every item that has no picture yet (even before a shot uses it), in the order shown
  const todo = data.assets.filter((a) => a.state !== 'approved' && !a.running && !a.latestReady)
  const label = { character: 'Characters', environment: 'Environments', property: 'Properties' }[type]
  return (
    <div className="pipe-panel">
      <div className="is-toolbar">
        <p className="is-counts"><strong>{c.inProject}</strong> {label.toLowerCase()} in the project · <strong>{c.approved}</strong> with an approved reference sheet{c.running > 0 ? ` · ${c.running} generating` : ''}</p>
        {todo.length > 0 && !confirmAll && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => setConfirmAll(true)}>Make all {todo.length} missing, one by one…</button>}
        {confirmAll && (
          <span className="is-confirm" role="alert">This will make {todo.length} reference sheet{todo.length === 1 ? '' : 's'}, one after another (not together), for about {usd(todo.length * 0.04)}.
            <button type="button" className="dossier-small-button studio-approve" disabled={busy} onClick={() => generate(todo.map((a) => a.dbId))}>Yes, make them</button>
            <button type="button" className="dossier-small-button" onClick={() => setConfirmAll(false)}>Cancel</button></span>
        )}
      </div>
      {message && <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>{message.text}</p>}
      {data.assets.length === 0 && <p className="dossier-note">Nothing here yet. The Silent Agent lists these when the screenplay is read — see the Blueprint’s Assets tab.</p>}
      <ul className="is-grid">
        {data.assets.map((a) => (
          <li key={a.dbId} className={`is-card ${a.state}`}>
            <header className="is-card-head"><strong>{a.assetId} · {a.name}</strong><StateBadge state={a.state} stale={a.canonical?.promptCurrent === false} /></header>
            {a.canonical ? <Picture version={a.canonical} backendUrl={backendUrl} alt={`Approved reference sheet of ${a.name}`} /> : <div className="is-empty">{a.state === 'generating' ? 'Generating…' : 'No approved reference sheet yet'}</div>}
            {type === 'character' && <OriginControl api={api} projectId={projectId} asset={a} onChanged={load} />}
            <div className="pipe-card-buttons">
              <button type="button" className="dossier-small-button" disabled={busy || a.running} onClick={() => generate([a.dbId])}>{a.running ? 'Generating…' : a.canonical || a.versions > 0 ? `Make another version (${usd(a.estimateUsd)})` : `Generate (${usd(a.estimateUsd)})`}</button>
            </div>
            <Versions slot={a} backendUrl={backendUrl} onReview={review} busy={busy} label={a.name} />
            {a.prompt && (
              <details className="is-prompt"><summary>Prompt (v{a.prompt.version}{a.prompt.edited ? ', edited' : ''}){a.prompt.stale ? ' — out of date' : ''}</summary>
                <ul className="bp-prompts"><PromptCard p={{ ...a.prompt, purpose: 'model_sheet', assetId: a.dbId }} label={`${a.assetId} model sheet`} api={`${api}`} projectId={projectId} onSaved={load} /></ul>
              </details>
            )}
            <details className="is-used"><summary>Used in {a.usedCount} shot{a.usedCount === 1 ? '' : 's'}</summary><p className="dossier-fine-print">{a.usedInShots.join(' · ') || 'No shot uses this yet.'}</p></details>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ShotFrames({ api, projectId, backendUrl }) {
  const [scenes, setScenes] = useState(null)
  const [waiting, setWaiting] = useState(null)
  const [sceneId, setSceneId] = useState(null)
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const loadScenes = useCallback(async () => {
    const r = await call(`${api}/${projectId}/studio/frames/scenes`)
    if (r.ok) { setScenes(r.data.scenes); setWaiting(r.data.waiting ?? null) }
  }, [api, projectId])
  const loadSlots = useCallback(async () => {
    if (!sceneId) return
    const r = await call(`${api}/${projectId}/studio/frames?sceneId=${sceneId}`)
    if (r.ok) setData(r.data)
  }, [api, projectId, sceneId])
  useEffect(() => { loadScenes() }, [loadScenes])
  useEffect(() => { if (scenes && !sceneId && scenes[0]) setSceneId(scenes[0].dbId) }, [scenes, sceneId])
  useEffect(() => { setData(null); loadSlots() }, [loadSlots])
  const refresh = useCallback(() => { loadScenes(); loadSlots() }, [loadScenes, loadSlots])
  useLive(projectId, backendUrl, refresh)
  async function generate(ids) {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/generate`, 'POST', { kind: 'keyframe', targetIds: ids })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Could not start.' })
    else setMessage({ tone: 'good', text: `Started ${r.data.started.length} first frame${r.data.started.length === 1 ? '' : 's'}.${r.data.skipped?.length ? ` ${r.data.skipped.length} waiting for references.` : ''}` })
    refresh()
  }
  async function review(id, decision) {
    setBusy(true)
    const r = await call(`${api}/${projectId}/generations/${id}/review`, 'POST', { decision })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error }); else refresh()
  }
  // finds the made characters, places and props each shot names and links them (only shots with nothing linked, or all of them)
  async function autoLink(all) {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/shots/auto-link`, 'POST', { sceneId: all ? null : sceneId, onlyUnlinked: !all })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Could not link.' })
    else setMessage({ tone: r.data.stillEmpty.length ? 'bad' : 'good', text: `Linked ${r.data.itemsAdded} item${r.data.itemsAdded === 1 ? '' : 's'} to ${r.data.shotsLinked} shot${r.data.shotsLinked === 1 ? '' : 's'}.${r.data.assumedCharacters?.length ? ` ${r.data.assumedCharacters.join(', ')} name no character, so the scene's own characters were linked — check with "🔗 Link…".` : ''}${r.data.stillEmpty.length ? ` Nothing could be found for ${r.data.stillEmpty.join(', ')} — use "🔗 Link…" on the shot to choose by hand.` : ''}` })
    refresh()
  }
  // the AI re-reads the scene's screenplay and writes the full frame of every shot, then links the made characters, place and props it names
  async function writeAll() {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/shots/write-descriptions`, 'POST', { sceneId })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Could not write the descriptions.' })
    else setMessage({ tone: r.data.written ? 'good' : 'bad', text: `Wrote ${r.data.written} full frame description${r.data.written === 1 ? '' : 's'} and linked the characters, places and props of ${r.data.linked} shot${r.data.linked === 1 ? '' : 's'}.${r.data.unknown?.length ? ` Names not in the project (left out): ${r.data.unknown.slice(0, 6).join('; ')}.` : ''} Check the result on each shot — you can edit it.` })
    refresh()
  }
  // an older project whose shot division is done: write the full frame description for EVERY shot of EVERY scene, shots stay as divided
  async function writeEverywhere() {
    setBusy(true); setMessage({ tone: 'good', text: 'Reading the screenplay scene by scene… this can take a minute or two.' })
    const r = await call(`${api}/${projectId}/shots/write-descriptions`, 'POST', { all: true })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Could not write the descriptions.' })
    else setMessage({ tone: r.data.failedScenes?.length || !r.data.written ? 'bad' : 'good', text: `Re-analysed ${r.data.scenes} scene${r.data.scenes === 1 ? '' : 's'}: wrote ${r.data.written} full frame description${r.data.written === 1 ? '' : 's'} and linked the made characters, places and props (${r.data.linked} shots). The shots themselves were not changed.${r.data.failedScenes?.length ? ` ${r.data.failedScenes.length} scene(s) failed — press again to retry.` : ''}${r.data.unknown?.length ? ` Names not in the project (left out): ${r.data.unknown.slice(0, 6).join('; ')}.` : ''}` })
    refresh()
  }
  if (!scenes) return <p className="dossier-note">Loading…</p>
  if (scenes.length === 0) {
    return (
      <p className="dossier-note">
        {waiting?.shots > 0
          ? `The shot division is not approved yet (${waiting.shots} shot${waiting.shots === 1 ? '' : 's'} in ${waiting.scenes} scene${waiting.scenes === 1 ? '' : 's'} waiting). Open the Storyboard Designer, check the shots and approve each scene — its shots appear here as soon as you approve it.`
          : 'No shots yet. The Storyboard Designer makes them from the locked screenplay; approve them there and they appear here.'}
      </p>
    )
  }
  if (waiting?.shots > 0) { /* some scenes are approved and shown below; the rest are still waiting in the Storyboard Designer */ }
  const readyIds = (data?.slots ?? []).filter((s) => s.readiness.ok && s.state !== 'approved' && !s.running && !s.latestReady).map((s) => s.dbId)
  return (
    <div className="is-frames">
      <nav className="is-scenes" aria-label="Scenes">
        {scenes.map((s) => (
          <button key={s.code} type="button" className={`is-scene${s.dbId === sceneId ? ' active' : ''}`} aria-current={s.dbId === sceneId ? 'true' : undefined} onClick={() => setSceneId(s.dbId)}>
            <strong>Scene {s.number}</strong>
            <span>{s.approved}/{s.shots} approved{s.review ? ` · ${s.review} to review` : ''}{s.blocked ? ` · ${s.blocked} waiting` : ''}</span>
          </button>
        ))}
      </nav>
      <div className="is-slots">
        {!data && <p className="dossier-note">Loading…</p>}
        {data && (
          <>
            <div className="is-toolbar">
              <p className="is-counts"><strong>{data.counts.shots}</strong> planned frames · <strong>{data.counts.approved}</strong> approved · {data.counts.review} waiting for review · {data.counts.readyToMake} ready to make · {data.counts.blocked} waiting for references</p>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={writeEverywhere}>🔁 Re-analyse ALL scenes — write full descriptions for every divided shot</button>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={writeAll}>✍ Write full descriptions from the screenplay (this scene)</button>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={() => autoLink(false)}>🔗 Auto-link characters, places &amp; props (this scene)</button>
              <button type="button" className="dossier-small-button" disabled={busy || readyIds.length === 0} onClick={() => generate(readyIds)}>Make the {readyIds.length} ready frame{readyIds.length === 1 ? '' : 's'} (≈{usd(readyIds.length * 0.04)})</button>
            </div>
            {message && <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>{message.text}</p>}
            <ul className="is-grid is-grid-wide">
              {data.slots.map((s) => (
                <li key={s.dbId} className={`is-card ${s.state}`}>
                  <header className="is-card-head"><strong>{s.shotId}</strong><span className="dossier-fine-print">{s.framing ?? ''}{s.cameraMove && s.cameraMove !== 'Static' ? ` · ${s.cameraMove}` : ''} · {(s.plannedDurationMs / 1000).toFixed(0)}s</span><StateBadge state={s.state} stale={s.stale} /></header>
                  <p className="is-action">{s.action}</p>
                  <FrameDescription api={api} projectId={projectId} shot={s} onChanged={refresh} />
                  <ul className="is-deps" aria-label="References this frame needs">
                    {s.dependencies.map((d) => <li key={d.code} className={d.approved ? 'ok' : 'missing'}>{d.approved ? '✓' : '✕'} {d.code} {d.name}</li>)}
                  </ul>
                  {s.canonical ? <Picture version={s.canonical} backendUrl={backendUrl} alt={`Approved first frame of ${s.shotId}`} /> : <div className="is-empty">{s.running ? 'Generating…' : 'No approved first frame yet'}</div>}
                  <div className="pipe-card-buttons">
                    <button type="button" className="dossier-small-button" disabled={busy || s.running || !s.readiness.ok} title={s.readiness.ok ? '' : `Needs: ${s.readiness.missing.join(', ') || 'shot division approval'}`} onClick={() => generate([s.dbId])}>{s.running ? 'Generating…' : s.versions > 0 ? 'Make another version ($0.04)' : 'Generate first frame ($0.04)'}</button>
                    <LinkPicker api={api} projectId={projectId} shot={s} onChanged={refresh} />
                    {!s.readiness.ok && <span className="dossier-fine-print">Needs an approved reference: {s.readiness.missing.join(', ') || 'the shot division approved'}</span>}
                  </div>
                  <Versions slot={s} backendUrl={backendUrl} onReview={review} busy={busy} label={s.shotId} />
                  {s.prompt && (
                    <details className="is-prompt"><summary>First-frame prompt (v{s.prompt.version}{s.prompt.edited ? ', edited' : ''}){s.prompt.stale ? ' — out of date' : ''}</summary>
                      <ul className="bp-prompts"><PromptCard p={{ ...s.prompt, purpose: 'first_frame', shotId: s.dbId }} label={`${s.shotId} first frame`} api={`${api}`} projectId={projectId} onSaved={refresh} /></ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

// The complete first frame of a shot, written from the screenplay (who is in it, what each does, the place, the objects). The
// picture command uses this text. The AI writes it; it can be edited here.
function FrameDescription({ api, projectId, shot, onChanged }) {
  const [text, setText] = useState(shot.frameDescription || '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  useEffect(() => { setText(shot.frameDescription || '') }, [shot.frameDescription])
  async function write() {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/shots/write-descriptions`, 'POST', { shotId: shot.dbId })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Could not write it.' })
    else setMessage({ tone: r.data.written ? 'good' : 'bad', text: r.data.written ? `Written and linked${r.data.unknown?.length ? ` (not in the project, left out: ${r.data.unknown.join('; ')})` : ''}.` : 'The AI gave nothing for this shot — try again.' })
    onChanged()
  }
  async function save() {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/shots/${shot.dbId}/frame-description`, 'PUT', { text })
    setBusy(false)
    if (!r.ok) setMessage({ tone: 'bad', text: r.data.error || 'Could not save.' }); else { setMessage({ tone: 'good', text: 'Saved.' }); onChanged() }
  }
  return (
    <div className="is-frame-description">
      <label className="dossier-fine-print">Full frame description (used for the picture)
        <textarea rows={4} value={text} placeholder="Not written yet — press “✍ Write from screenplay”, or type it yourself." onChange={(e) => setText(e.target.value)} style={{ width: '100%' }} />
      </label>
      <div className="pipe-card-buttons">
        <button type="button" className="dossier-small-button" disabled={busy} onClick={write}>{busy ? 'Working…' : '✍ Write from screenplay'}</button>
        {text !== (shot.frameDescription || '') && <button type="button" className="dossier-small-button studio-approve" disabled={busy} onClick={save}>Save my text</button>}
      </div>
      {message && <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role="status">{message.text}</p>}
    </div>
  )
}

// Choose by hand which made characters, places and props a shot uses (the picture is built only from these).
function LinkPicker({ api, projectId, shot, onChanged }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(null)
  const [picked, setPicked] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function toggleOpen() {
    if (open) { setOpen(false); return }
    setOpen(true); setError(null)
    const r = await call(`${api}/${projectId}/shots/${shot.dbId}/links`)
    if (!r.ok) { setError(r.data.error || 'Could not load.'); return }
    setItems(r.data.items); setPicked(new Set(r.data.items.filter((i) => i.linked).map((i) => i.id)))
  }
  async function save() {
    setBusy(true); setError(null)
    const r = await call(`${api}/${projectId}/shots/${shot.dbId}/links`, 'PUT', { assetIds: [...picked] })
    setBusy(false)
    if (!r.ok) { setError(r.data.error || 'Could not save.'); return }
    setOpen(false); onChanged()
  }
  const label = { character: 'Characters', location: 'Environments', prop: 'Props', other: 'Other' }
  return (
    <div className="is-link-picker">
      <button type="button" className="dossier-small-button" onClick={toggleOpen}>🔗 Link…</button>
      {open && (
        <div className="is-link-box">
          {!items && !error && <p className="dossier-note">Loading…</p>}
          {error && <p className="dossier-error" role="alert">{error}</p>}
          {items && ['character', 'location', 'prop', 'other'].map((k) => {
            const list = items.filter((i) => i.kind === k)
            return list.length === 0 ? null : (
              <fieldset key={k}><legend>{label[k]}</legend>
                {list.map((i) => <label key={i.id} className="pipe-inline"><input type="checkbox" checked={picked.has(i.id)} onChange={(e) => setPicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n })} /> {i.code} {i.name}</label>)}
              </fieldset>
            )
          })}
          {items && <button type="button" className="dossier-small-button studio-approve" disabled={busy} onClick={save}>Save links</button>}
        </div>
      )}
    </div>
  )
}

// "Out of date" appears when the commands changed after a picture was made (new style, cast rule, descriptions, reference images).
// This ties every existing picture to the current command so nothing has to be made again. Free; no picture is touched.
function KeepPictures({ api, projectId, onDone }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const run = useCallback(async (quiet) => {
    setBusy(true); if (!quiet) setMessage(null)
    const r = await call(`${api}/${projectId}/studio/accept-current`, 'POST', {})
    setBusy(false)
    if (!r.ok) { if (!quiet) setMessage({ tone: 'bad', text: r.data.error || 'Could not update.' }); return }
    if (!quiet || r.data.accepted > 0) { setMessage({ tone: 'good', text: r.data.accepted > 0 ? `Done — ${r.data.accepted} picture${r.data.accepted === 1 ? '' : 's'} are now up to date and linked to the shots. Nothing was made again.` : 'Everything is already up to date.' }); onDone() }
  }, [api, projectId, onDone])
  // once per project, on first open, so old pictures are not left "out of date" for no reason
  useEffect(() => {
    const key = `keepPictures:${projectId}`
    let seen = false
    try { seen = Boolean(localStorage.getItem(key)); localStorage.setItem(key, '1') } catch { /* private window */ }
    if (!seen) run(true)
  }, [projectId, run])
  return (
    <p className="pipe-toolbar">
      <button type="button" className="dossier-small-button" disabled={busy} onClick={() => run(false)}>{busy ? 'Updating…' : '✓ Keep my pictures — mark everything up to date (free)'}</button>
      {message && <span className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role="status"> {message.text}</span>}
    </p>
  )
}

export default function ImageStudio({ projectId, backendUrl }) {
  const api = `${backendUrl}/api/production`
  const [tab, setTab] = useState('character')
  const [refresh, setRefresh] = useState(0)
  const tabs = useMemo(() => [
    { key: 'character', label: 'Characters' }, { key: 'environment', label: 'Environments' }, { key: 'property', label: 'Properties' }, { key: 'frames', label: 'Shot Frames' },
  ], [])
  return (
    <div className="is">
      <StylePicker api={api} projectId={projectId} />
      <ReferenceImages api={api} backendUrl={backendUrl} projectId={projectId} />
      <p className="pipe-toolbar">
        <a className="dossier-small-button studio-link" href={`${api}/${projectId}/image-prompts.pdf`} target="_blank" rel="noreferrer">📄 Download all image commands (PDF) — characters, environments, properties, shots</a>
      </p>
      <KeepPictures api={api} projectId={projectId} onDone={() => setRefresh((n) => n + 1)} />
      <ImportPictures api={api} projectId={projectId} onImported={() => setRefresh((n) => n + 1)} />
      <nav className="dossier-tabs is-tabs" aria-label="Image Studio areas">
        {tabs.map((t) => <button key={t.key} type="button" className={tab === t.key ? 'dossier-tab active' : 'dossier-tab'} aria-current={tab === t.key ? 'page' : undefined} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </nav>
      {tab === 'property' && <PropCombiner api={api} projectId={projectId} />}
      {tab === 'frames' ? <ShotFrames key={refresh} api={api} projectId={projectId} backendUrl={backendUrl} /> : <Library key={`${tab}-${refresh}`} type={tab} api={api} projectId={projectId} backendUrl={backendUrl} />}
    </div>
  )
}
