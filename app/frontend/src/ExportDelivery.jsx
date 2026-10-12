// Export & Delivery. Exports always render a SAVED timeline version (a frozen copy), never the live timeline, so
// what is rendered is exactly what was saved. Before rendering the page checks the version and says plainly whether
// it contains placeholders (shots with nothing approved yet) or media that is not the approved one.

import { useCallback, useEffect, useState } from 'react'
import { useLive } from './useLive.js'
import { call, fmtTime } from './TimelineView.jsx'
import './Production.css'

export default function ExportDelivery({ projectId, backendUrl, onNavigate }) {
  const api = `${backendUrl}/api/production/${projectId}`
  const [snaps, setSnaps] = useState(null)
  const [ffmpeg, setFfmpeg] = useState(true)
  const [chosen, setChosen] = useState(null)
  const [check, setCheck] = useState(null)
  const [approvedOnly, setApprovedOnly] = useState(false)
  const [exports, setExports] = useState([])
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await call(`${api}/timeline/snapshots`)
    if (r.ok) { setSnaps(r.data.snapshots); setFfmpeg(r.data.ffmpeg); setChosen((c) => c ?? r.data.snapshots[0]?.id ?? null) }
    const e = await call(`${api}/exports`)
    if (e.ok) setExports((e.data.exports ?? []).filter((x) => x.snapshotId))
  }, [api])
  useEffect(() => { load() }, [load])
  useLive(projectId, backendUrl, load)

  useEffect(() => {
    if (!chosen) { setCheck(null); return }
    let cancelled = false
    call(`${api}/timeline/snapshots/${chosen}/validate?placeholders=${approvedOnly ? 'refuse' : 'black'}`).then((r) => { if (!cancelled) setCheck(r.ok ? r.data : null) })
    return () => { cancelled = true }
  }, [api, chosen, approvedOnly])

  async function save() {
    const r = await call(`${api}/timeline/snapshots`, 'POST', { label: '' })
    if (r.ok) { setChosen(r.data.snapshot.id); setMessage({ ok: true, text: `Saved timeline version ${r.data.snapshot.version}.` }); load() }
    else setMessage({ ok: false, text: r.data?.error ?? 'Could not save the timeline.' })
  }
  async function start() {
    if (busy || !chosen) return
    setBusy(true)
    const r = await call(`${api}/timeline/snapshots/${chosen}/export`, 'POST', { placeholders: approvedOnly ? 'refuse' : 'black' })
    setBusy(false)
    setMessage(r.ok ? { ok: true, text: 'Export started. It will appear below when it is ready.' } : { ok: false, text: r.data?.error ?? 'Could not start the export.' })
    load()
  }
  const running = exports.some((x) => x.status === 'running')
  if (!snaps) return <p className="dossier-note">Loading…</p>
  const snap = snaps.find((s) => s.id === chosen)
  return (
    <div className="ex">
      <section>
        <h3>1 · Choose a saved timeline version</h3>
        <p className="dossier-note">Exports are made from a saved copy of the timeline, so later edits never change an export that is already running. Save a new version after editing.</p>
        <button type="button" className="dossier-small-button" onClick={save}>Save the current timeline as a new version</button>
        {snaps.length === 0 && <p className="dossier-note">No versions saved yet. {' '}<button type="button" className="dossier-small-button" onClick={() => onNavigate?.('timeline')}>Open the Timeline</button></p>}
        <ul className="ex-list">
          {snaps.map((s) => (
            <li key={s.id} className={`ex-snap${s.id === chosen ? ' chosen' : ''}`}>
              <label><input type="radio" name="snapshot" checked={s.id === chosen} onChange={() => setChosen(s.id)} /> <strong>Version {s.version}</strong>{s.label ? ` · ${s.label}` : ''}</label>
              <span className="dossier-fine-print">{new Date(s.createdAt).toLocaleString()} · {s.summary.shots} shots · {fmtTime(s.summary.durationMs)} · {s.summary.placeholders} placeholders</span>
            </li>
          ))}
        </ul>
      </section>
      {snap && (
        <section>
          <h3>2 · Check before rendering</h3>
          {!check && <p className="dossier-note">Checking…</p>}
          {check && (
            <>
              <p role="status" className={check.contains.approvedOnly ? 'dossier-note' : 'dossier-error'}>
                {check.contains.approvedOnly
                  ? 'Everything in this version uses approved media.'
                  : `This version is NOT final: ${check.contains.placeholders} shot${check.contains.placeholders === 1 ? '' : 's'} still ${check.contains.placeholders === 1 ? 'is a placeholder' : 'are placeholders'} and ${check.contains.unapprovedMedia} clip${check.contains.unapprovedMedia === 1 ? ' uses' : 's use'} media that is not approved.`}
              </p>
              <label><input type="checkbox" checked={approvedOnly} onChange={(e) => setApprovedOnly(e.target.checked)} /> Only export if everything is approved (refuse placeholders)</label>
              {check.errors.map((e, i) => <p key={`e${i}`} className="dossier-error" role="alert">✖ {e.message}</p>)}
              {check.warnings.map((w, i) => <p key={`w${i}`} className="dossier-note">⚠ {w.message}</p>)}
              <p className="dossier-fine-print">Expected length {fmtTime(check.expectedDurationMs)} · {check.audibleClips} sound clips will be heard.</p>
            </>
          )}
          {!ffmpeg && <p className="dossier-error" role="alert">The video maker (ffmpeg) is not installed on the server, so only the edit package can be made.</p>}
          <button type="button" className="dossier-small-button" disabled={busy || running || !check || !check.ok} onClick={start}>{running ? 'An export is running…' : 'Render rough cut + edit package'}</button>
        </section>
      )}
      {message && <p className={message.ok ? 'dossier-note' : 'dossier-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
      <section>
        <h3>3 · Exports</h3>
        {exports.length === 0 && <p className="dossier-note">Nothing exported from a saved version yet.</p>}
        <ul className="ex-list">
          {exports.map((x) => (
            <li key={x.id} className="ex-snap">
              <strong>Export #{x.id}</strong> — {x.status === 'ready' ? 'ready' : x.status === 'failed' ? 'failed' : 'rendering…'}
              <span className="dossier-fine-print">from timeline version {snaps.find((s) => s.id === x.snapshotId)?.version ?? x.snapshotId}</span>
              {x.status === 'failed' && <p className="dossier-error" role="alert">{x.error}</p>}
              {x.status === 'ready' && (
                <>
                  <p className="ex-flags dossier-fine-print">
                    <span>{x.report?.approvedOnly ? '✔ approved media only' : '⚠ contains placeholders or unapproved media'}</span>
                    <span>placeholders: {x.report?.validation?.contains?.placeholders ?? 0}</span>
                    {x.report?.durationCheck && <span>length check: {x.report.durationCheck.withinTolerance ? 'OK' : 'does not match'} ({fmtTime(x.report.durationCheck.measuredMs ?? 0)} vs {fmtTime(x.report.durationCheck.expectedMs)})</span>}
                  </p>
                  {x.note && <p className="dossier-note">{x.note}</p>}
                  {x.videoUrl && <p><a href={`${backendUrl}${x.videoUrl}`}>Download rough cut (.mp4)</a></p>}
                  {x.packageUrl && <p><a href={`${backendUrl}${x.packageUrl}`}>Download edit package (.zip)</a></p>}
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
