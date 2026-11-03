import { useCallback, useEffect, useRef, useState } from 'react'
import './SmartScheduler.css'

// Production Management → "Artist scripts, ready to send": every character's script packet (details, arc, emotional graph) is prepared BEFORE it is needed,
// in English, Odia and Hindi. The work runs on the server (after Synchronize it starts by itself); this card only FOLLOWS it: what is being made right now,
// how many are done, how long it has run — and it picks the job up again after a reload.
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }

export default function PacketPrep({ backendUrl, sceneListId }) {
  const [info, setInfo] = useState(null) // { job, ready, total, characters }
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const offset = useRef(0) // server clock minus this device's clock
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/packet-jobs/current`)
      const body = await response.json().catch(() => ({}))
      if (!alive.current) return null
      if (!response.ok) { setError(body.error || 'Could not check the artist scripts.'); return null }
      if (body.job?.now) offset.current = body.job.now - Date.now()
      setError('')
      setInfo(body)
      return body
    } catch {
      return null // the server may be restarting: the next look tries again
    }
  }, [backendUrl, sceneListId])

  useEffect(() => {
    alive.current = true
    load()
    return () => { alive.current = false }
  }, [load])

  const running = info?.job?.status === 'running'
  // while it runs: look at the server every 3 seconds and tick the clock every second
  useEffect(() => {
    if (!running) return undefined
    const look = setInterval(load, 3000)
    const clockTick = setInterval(() => setTick((t) => t + 1), 1000)
    return () => { clearInterval(look); clearInterval(clockTick) }
  }, [running, load])

  async function start() {
    setBusy(true); setError('')
    try {
      const response = await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/packet-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) setError(body.error || 'Something went wrong. Please try again.')
      await load()
    } catch {
      setError('Could not reach the server — it may be waking up or restarting. Wait a minute and press the button again.')
    }
    setBusy(false)
  }

  async function stop() {
    if (!info?.job?.jobId) return
    try { await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/packet-jobs/${info.job.jobId}/stop`, { method: 'POST' }) } catch { /* the next look shows what happened */ }
    load()
  }

  if (!info || info.total === 0) return null // no characters found in the script: nothing to prepare
  const job = info.job
  const left = info.total - info.ready
  const elapsed = job?.startedAt ? (running ? Date.now() + offset.current : (job.finishedAt ?? Date.now() + offset.current)) - job.startedAt : 0
  void tick
  const percent = running && job.total ? Math.round((job.done / job.total) * 100) : Math.round((info.ready / info.total) * 100)

  return (
    <div className="ss-card sync-card packet-prep">
      <h3>📨 Artist scripts — ready to send</h3>
      <p className="ss-sub">Each artist's script holds the character's details, how the character changes (the arc), how the feeling rises and falls (the emotional graph) and every scene they are in, in full. Preparing them now, in English, Odia and Hindi, means sending a link or opening a PDF is instant — nobody waits for the AI at that moment. After <b>Synchronize</b> this starts by itself.</p>

      <div className="packet-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,.25)', overflow: 'hidden', margin: '8px 0' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: '#2e9e5b', transition: 'width .4s' }} />
      </div>

      {running ? (
        <>
          <p className="sync-live">⏳ {job.step} · <b>{job.done + job.failed.length}</b> of {job.total} done · running for <b>{clock(elapsed)}</b>. You can leave this page open, or come back later — the work goes on on the server.</p>
          {job.notice && <p className="ss-note" role="status">🔁 {job.notice}</p>}
          <button type="button" className="ss-back" onClick={stop}>Stop after this one</button>
        </>
      ) : (
        <>
          <p className="ss-note">
            {left === 0
              ? `✓ All ${info.characters} characters × 3 languages are ready (${info.ready} scripts). Sending and opening is instant.`
              : `${info.ready} of ${info.total} scripts are ready (${info.characters} characters × 3 languages). ${left} still to prepare.`}
          </p>
          {left > 0 && <button type="button" className="ss-go" onClick={start} disabled={busy}>{busy ? 'Starting…' : info.ready > 0 ? `📨 Prepare the missing ${left}` : '📨 Prepare all artist scripts'}</button>}
          {job?.status === 'done' && job.failed.length === 0 && left === 0 && <p className="ss-note">Finished in {clock(elapsed)}.</p>}
          {job?.failed?.length > 0 && <p className="ss-error" role="alert">{job.failed.length} could not be prepared this time ({job.failed.at(-1).error || 'the AI did not answer'}). Press the button to try those again; their scenes can still be sent in full meanwhile.</p>}
          {job?.status === 'error' && job.error && <p className="ss-error" role="alert">{job.error}</p>}
          {job?.status === 'stopped' && <p className="ss-note">Stopped. Press the button to carry on with the rest.</p>}
        </>
      )}
      {error && <p className="ss-error" role="alert">{error}</p>}
    </div>
  )
}
