// Editing controls for the Timeline. Every button sends ONE named edit to the server, which records it so it can be
// undone. Nothing here changes the made pictures/videos/voices or the lengths planned in the Blueprint.
// "Ripple" is always the editor's explicit choice: when ON, everything after the edited clip moves with it.

import { useCallback, useEffect, useState } from 'react'
import { fmtTime } from './TimelineView.jsx'

const toMs = (seconds) => Math.round(Number(seconds) * 1000)

export default function TimelineEditBar({ api, projectId, tl, clip, shotClips, playhead, call, reload }) {
  const [ripple, setRipple] = useState(false)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [length, setLength] = useState('')
  const [source, setSource] = useState('')
  const [start, setStart] = useState('')
  const base = `${api}/${projectId}/timeline`

  const loadHistory = useCallback(async () => {
    const r = await call(`${base}/history`)
    if (r.ok) setHistory(r.data)
  }, [base, call])
  useEffect(() => { loadHistory() }, [loadHistory, tl.editRevision])
  useEffect(() => {
    setLength(clip ? (clip.durationMs / 1000).toFixed(1) : '')
    setSource(clip ? (clip.sourceInMs / 1000).toFixed(1) : '')
    setStart(clip ? (clip.startMs / 1000).toFixed(1) : '')
    setMessage(null)
  }, [clip?.id, clip?.durationMs, clip?.sourceInMs, clip?.startMs]) // eslint-disable-line react-hooks/exhaustive-deps

  async function send(path, body, okText) {
    if (busy) return
    setBusy(true)
    const r = await call(`${base}/${path}`, 'POST', { ...body, expectedRevision: tl.editRevision })
    setBusy(false)
    if (r.ok) { setMessage({ ok: true, text: okText ?? `Done: ${r.data.label ?? 'edit applied'}.` }); await reload(); loadHistory() }
    else {
      const needsRipple = r.data?.code === 'ripple_required'
      setMessage({ ok: false, text: needsRipple ? `${r.data.error} Turn on “Ripple” to push the clips after it later.` : (r.data?.error ?? 'That did not work.') })
      if (r.data?.code === 'stale_revision') reload()
    }
  }
  const edit = (op, text) => send('edit', { op }, text)
  const idx = clip ? shotClips.findIndex((c) => c.id === clip.id) : -1
  const isShot = clip?.kind === 'shot'
  const inside = isShot && playhead > clip.startMs + 300 && playhead < clip.startMs + clip.durationMs - 300
  const hasVideo = clip?.state === 'video'

  return (
    <section className="tl-edit" aria-label="Edit the timeline">
      <div className="tl-edit-row">
        <button type="button" className="dossier-small-button" disabled={!history.canUndo || busy} onClick={() => send('undo', {}, 'Undid the last edit.')}>↶ Undo</button>
        <button type="button" className="dossier-small-button" disabled={!history.canRedo || busy} onClick={() => send('redo', {}, 'Redid the edit.')}>↷ Redo</button>
        <label className="tl-ripple" title="Ripple: everything after the clip moves by the same amount, on every track.">
          <input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} /> Ripple
        </label>
        <span className="dossier-fine-print">{ripple ? 'ON — clips after the edit move with it.' : 'OFF — nothing else moves; an edit that would overlap is refused.'}</span>
      </div>
      {clip ? (
        <div className="tl-edit-row" role="group" aria-label={`Edit ${clip.label}`}>
          <strong className="tl-edit-name">{isShot ? clip.shotRef : clip.label}{clip.part > 0 ? ` · part ${clip.part + 1}` : ''}</strong>
          {isShot && (
            <>
              <label>Length (s) <input type="number" step="0.1" min="0.3" value={length} onChange={(e) => setLength(e.target.value)} aria-label="Length in seconds" /></label>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={() => edit({ type: 'trim', clipId: clip.id, durationMs: toMs(length), ripple })}>Set length</button>
              {hasVideo && (
                <>
                  <label>Start in video (s) <input type="number" step="0.1" min="0" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Where in the video this clip starts" /></label>
                  <button type="button" className="dossier-small-button" disabled={busy} onClick={() => edit({ type: 'slip', clipId: clip.id, sourceInMs: toMs(source) })}>Slip</button>
                </>
              )}
              <button type="button" className="dossier-small-button" disabled={busy || !inside} title={inside ? `Cut at ${fmtTime(playhead)}` : 'Click the ruler inside this clip to place the playhead first'} onClick={() => edit({ type: 'split', clipId: clip.id, atMs: Math.round(playhead) })}>Split at playhead</button>
              <button type="button" className="dossier-small-button" disabled={busy || idx <= 0} onClick={() => edit({ type: 'reorder', clipId: clip.id, beforeClipId: shotClips[idx - 1].id })}>← Earlier</button>
              <button type="button" className="dossier-small-button" disabled={busy || idx < 0 || idx >= shotClips.length - 1} onClick={() => edit({ type: 'reorder', clipId: clip.id, beforeClipId: shotClips[idx + 2]?.id ?? null })}>Later →</button>
              {clip.takeOverride && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => edit({ type: 'take', clipId: clip.id, generationId: null })}>Back to approved take</button>}
            </>
          )}
          {!isShot && (
            <>
              <label>Starts at (s) <input type="number" step="0.1" min="0" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start time in seconds" /></label>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={() => edit({ type: 'move', clipId: clip.id, startMs: toMs(start) })}>Move</button>
              {(clip.kind === 'sfx' || clip.kind === 'music') ? <button type="button" className="dossier-small-button" disabled={busy} onClick={() => edit({ type: 'delete', clipId: clip.id })}>Remove from timeline</button> : null}
            </>
          )}
        </div>
      ) : <p className="dossier-fine-print">Choose a clip to edit it.</p>}
      {message && <p className={message.ok ? 'dossier-note' : 'dossier-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
    </section>
  )
}
