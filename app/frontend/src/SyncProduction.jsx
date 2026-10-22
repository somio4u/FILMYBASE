import { useCallback, useEffect, useRef, useState } from 'react'
import './SmartScheduler.css'

// Production Management → "Synchronize with the latest screenplay": rebuilds the Script Breakdown, the AD scene sheet and the Shoot Schedule from the CURRENT screenplay, step by step.
// The job runs on the server; this card only FOLLOWS it. It picks the job up again by itself when the screen reloads or refreshes (so progress never disappears),
// shows what each step is doing, and counts the running time so you can see it is alive.
const ICON = { waiting: '○', working: '⏳', done: '✓', skipped: '–', warning: '⚠', error: '⚠' }
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }

export default function SyncProduction({ backendUrl, sceneListId, onDone }) {
  const [job, setJob] = useState(null) // { jobId, status, steps, cast, error, startedAt, finishedAt }
  const [asking, setAsking] = useState(false) // the "are you sure" step, inside the card (a pop-up can be blocked by the browser)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const offset = useRef(0) // server clock minus this device's clock
  const following = useRef(null) // the job id being followed
  const alive = useRef(true)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const follow = useCallback(async (jobId, announceDone) => {
    if (following.current === jobId) return
    following.current = jobId
    try {
      for (;;) {
        const response = await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/sync-production/${jobId}`)
        const status = await response.json()
        if (!alive.current) return
        if (!response.ok) throw new Error(status.error || 'The synchronization was interrupted. Press Synchronize again.')
        if (status.now) offset.current = status.now - Date.now()
        setJob({ jobId, ...status })
        if (status.status !== 'running') {
          if (status.status === 'done' && announceDone) await onDoneRef.current?.()
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 2500))
        if (!alive.current) return
      }
    } catch (e) { if (alive.current) { setError(e.message); setJob(null) } }
    if (following.current === jobId) following.current = null
  }, [backendUrl, sceneListId])

  // on every mount (also after the screen refreshed itself): is a synchronization running, or just finished?
  useEffect(() => {
    alive.current = true
    fetch(`${backendUrl}/api/scene-lists/${sceneListId}/sync-production/current`)
      .then((r) => r.json())
      .then((c) => {
        if (!alive.current || !c?.jobId) return
        if (c.now) offset.current = c.now - Date.now()
        setJob(c)
        // a job that is still running is followed; a finished one is only shown
        if (c.status === 'running') follow(c.jobId, true)
      })
      .catch(() => {})
    return () => { alive.current = false; following.current = null }
  }, [backendUrl, sceneListId, follow])

  // a running clock, so the screen visibly moves even between two answers from the server
  useEffect(() => {
    if (job?.status !== 'running') return undefined
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [job?.status])

  async function start() {
    setAsking(false); setError('')
    try {
      const started = await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/sync-production`, { method: 'POST' })
      const first = await started.json()
      if (!started.ok) throw new Error(first.error || 'Something went wrong. Please try again.')
      if (first.serverNow) offset.current = first.serverNow - Date.now()
      setJob({ jobId: first.jobId, status: 'running', steps: [], cast: null, error: null, startedAt: Date.now() + offset.current })
      follow(first.jobId, true)
    } catch (e) { setError(e.message) }
  }

  const running = job?.status === 'running'
  const elapsed = job?.startedAt ? (running ? Date.now() + offset.current : job.finishedAt ?? Date.now() + offset.current) - job.startedAt : 0
  void tick

  return (
    <div className="ss-card sync-card">
      <h3>🔄 Synchronize with the latest screenplay</h3>
      <p className="ss-sub">Production Management keeps what the screenplay said when each part was last made. After the screenplay changes, press Synchronize and the Script Breakdown, the AD scene sheet and the Shoot Schedule are rebuilt from the new screenplay — all in one go. The cast you assigned, the availability you typed and the days already shot are kept.</p>

      {!running && !asking && <button type="button" className="ss-go" onClick={() => setAsking(true)}>🔄 Synchronize now</button>}
      {asking && (
        <div className="sync-ask" role="alertdialog">
          <p><b>Rebuild everything in Production Management from the CURRENT screenplay?</b></p>
          <ul>
            <li>Script Breakdown, AD scene sheet and Shoot Schedule are made again (the old versions stay in history).</li>
            <li>The cast you assigned, the availability you typed and the days already shot are kept.</li>
            <li>It reads the whole screenplay with AI: it takes several minutes (a long series can take 20 or more) and uses AI credit. You can leave this page open and watch.</li>
          </ul>
          <button type="button" className="ss-go" onClick={start}>Yes, synchronize now</button>{' '}
          <button type="button" className="ss-back" onClick={() => setAsking(false)}>Cancel</button>
        </div>
      )}

      {running && <p className="sync-live">⏳ Working on the server… running for <b>{clock(elapsed)}</b>. Nothing is stuck while the clock runs and a step shows ⏳ — you can leave this page open.</p>}
      {error && <p className="ss-error" role="alert">{error}</p>}
      {job && job.steps?.length > 0 && (
        <ul className="sync-steps">
          {job.steps.map((s) => (
            <li key={s.key} className={`sync-step is-${s.state}`}>
              <span aria-hidden="true">{ICON[s.state]}</span> {s.label}
              {s.note ? <small> — {s.note}</small> : null}
              {s.state === 'working' && s.startedAt ? <small> · this step: {clock(Date.now() + offset.current - s.startedAt)}</small> : null}
            </li>
          ))}
        </ul>
      )}
      {job?.status === 'error' && <p className="ss-error" role="alert">Synchronization stopped: {job.error}. Nothing was lost — the previous versions are still there. Press Synchronize to try again.</p>}
      {job?.status === 'done' && (
        <div className="ss-note" role="status">
          <b>Everything now follows the new screenplay</b>{job.finishedAt && job.startedAt ? ` (took ${clock(job.finishedAt - job.startedAt)})` : ''}.
          {job.cast?.withoutActor?.length > 0 && <p>No actor yet for: {job.cast.withoutActor.join(', ')}.</p>}
          {job.cast?.orphanedActors?.length > 0 && <p>These actors' characters are no longer in the screenplay: {job.cast.orphanedActors.map((o) => `${o.actor} (${o.character})`).join(', ')}.</p>}
        </div>
      )}
    </div>
  )
}
