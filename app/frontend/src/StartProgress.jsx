import { useCallback, useEffect, useRef, useState } from 'react'
import './SmartScheduler.css'

// "Let's go" when the writer starts FROM a synopsis / bit sheet / scene one-liners: the server makes the project in the background (see
// skipStartJobs.js). This card only FOLLOWS that job: what it is doing now, how long it has run, and it picks the job up again by itself after
// a reload, so progress never disappears. When the project is ready it hands the project over (onDone) and the writer lands in it.
const SEEN_KEY = 'filmybase:skipJobSeen'
const seen = () => { try { return localStorage.getItem(SEEN_KEY) } catch { return null } }
const markSeen = (id) => { try { localStorage.setItem(SEEN_KEY, id) } catch { /* private window: it may be shown once more */ } }
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }

export default function StartProgress({ backendUrl, jobId, onDone, onRunningChange }) {
  const [job, setJob] = useState(null) // { jobId, status, step, notice, startedAt, error }
  const [reconnecting, setReconnecting] = useState('')
  const [tick, setTick] = useState(0)
  const offset = useRef(0) // server clock minus this device's clock
  const following = useRef(null)
  const alive = useRef(true)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onRunningRef = useRef(onRunningChange)
  onRunningRef.current = onRunningChange

  const finish = useCallback(async (status) => {
    markSeen(status.jobId)
    if (status.status === 'done') await onDoneRef.current?.(status.result)
  }, [])

  const follow = useCallback(async (id) => {
    if (following.current === id) return
    following.current = id
    let failures = 0
    try {
      for (;;) {
        let status = null
        let httpStatus = 0
        try {
          const response = await fetch(`${backendUrl}/api/skip-jobs/${id}`)
          httpStatus = response.status
          status = await response.json().catch(() => ({}))
          failures = 0
          setReconnecting('')
        } catch {
          // the server could not be reached (restarting after an update, waking up, a weak phone connection): keep trying; the work goes on there
          failures += 1
          if (!alive.current) return
          if (failures > 100) { setJob({ jobId: id, status: 'error', error: 'The server could not be reached for several minutes. Check your internet and open this page again — if your project was made, it is in YOUR PROJECTS.' }); break }
          setReconnecting(`Lost the connection to the server — trying again (${failures})… The work on the server is not stopped by this.`)
          await new Promise((resolve) => setTimeout(resolve, 3000))
          continue
        }
        if (!alive.current) return
        if (httpStatus === 404 || httpStatus === 401 || httpStatus === 403) { setJob({ jobId: id, status: 'error', error: status.error || 'This job was not found. Look in YOUR PROJECTS: if your project was made it is there.' }); break }
        if (status.now) offset.current = status.now - Date.now()
        setJob(status)
        if (status.status !== 'running') { await finish(status); break }
        await new Promise((resolve) => setTimeout(resolve, 2500))
        if (!alive.current) return
      }
    } finally { if (following.current === id) following.current = null }
  }, [backendUrl, finish])

  // a job just started by the parent
  useEffect(() => { if (jobId) follow(jobId) }, [jobId, follow])

  // on every mount (also after a reload): is a job running — or finished while this page was closed and not shown yet?
  useEffect(() => {
    alive.current = true
    fetch(`${backendUrl}/api/skip-jobs/current`)
      .then((r) => r.json())
      .then((c) => {
        if (!alive.current || !c?.jobId) return
        if (c.now) offset.current = c.now - Date.now()
        if (c.status === 'running') { setJob(c); follow(c.jobId) } else if (seen() !== c.jobId) { setJob(c); finish(c) }
      })
      .catch(() => {})
    return () => { alive.current = false; following.current = null }
  }, [backendUrl, follow, finish])

  const running = job?.status === 'running'
  useEffect(() => { onRunningRef.current?.(running) }, [running])
  useEffect(() => {
    if (!running) return undefined
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [running])
  void tick
  const elapsed = job?.startedAt ? (running ? Date.now() + offset.current : job.finishedAt ?? Date.now() + offset.current) - job.startedAt : 0

  if (!job) return null
  return (
    <div className="ss-card sync-card" role="status">
      {running && (
        <>
          <p className="sync-live">⏳ <b>{job.step || 'Working…'}</b></p>
          <p className="sync-live">Running for <b>{clock(elapsed)}</b>. Nothing is stuck while the clock runs — you can leave this page or close the app: it keeps working on the server and your project will be waiting in YOUR PROJECTS.</p>
        </>
      )}
      {job.notice && <p className="ss-note">🔁 {job.notice}</p>}
      {reconnecting && <p className="sync-live">🔌 {reconnecting}</p>}
      {job.status === 'error' && (
        <>
          <p className="ss-error" role="alert">{job.error}</p>
          <p className="ss-note">Your text is still in the box. Press “Let’s go” to try again.</p>
          <button type="button" className="ss-back" onClick={() => { markSeen(job.jobId); setJob(null) }}>OK</button>
        </>
      )}
      {job.status === 'done' && <p className="ss-note">✓ Your project is ready{elapsed ? ` (it took ${clock(elapsed)})` : ''}. Opening it…</p>}
    </div>
  )
}
