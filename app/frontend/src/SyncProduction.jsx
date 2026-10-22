import { useState } from 'react'
import './SmartScheduler.css'

// Production Management → "Synchronize with the latest screenplay": rebuilds the Script Breakdown, the AD scene sheet and the Shoot Schedule from the CURRENT screenplay, step by step.
const ICON = { waiting: '○', working: '⏳', done: '✓', skipped: '–', warning: '⚠', error: '⚠' }

export default function SyncProduction({ backendUrl, sceneListId, onDone }) {
  const [job, setJob] = useState(null) // { status, steps, cast, error }
  const [error, setError] = useState('')
  const running = job?.status === 'running'

  async function start() {
    if (running) return
    if (!window.confirm('Rebuild everything in Production Management from the CURRENT screenplay?\n\n• Script Breakdown, AD scene sheet and Shoot Schedule are made again (the old versions stay in history).\n• Cast already assigned to characters, availability you typed, and days already shot are kept.\n• It reads the whole screenplay with AI, so it takes several minutes and uses AI credit.')) return
    setError(''); setJob({ status: 'running', steps: [], cast: null, error: null })
    try {
      const started = await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/sync-production`, { method: 'POST' })
      const first = await started.json()
      if (!started.ok) throw new Error(first.error || 'Something went wrong. Please try again.')
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const response = await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/sync-production/${first.jobId}`)
        const status = await response.json()
        if (!response.ok) throw new Error(status.error || 'The synchronization was interrupted. Press Synchronize again.')
        setJob(status)
        if (status.status !== 'running') {
          if (status.status === 'done') await onDone?.()
          break
        }
      }
    } catch (e) { setError(e.message); setJob(null) }
  }

  return (
    <div className="ss-card sync-card">
      <h3>🔄 Synchronize with the latest screenplay</h3>
      <p className="ss-sub">Production Management keeps what the screenplay said when each part was last made. After the screenplay changes, press Synchronize and the Script Breakdown, the AD scene sheet and the Shoot Schedule are rebuilt from the new screenplay — all in one go. The cast you assigned, the availability you typed and the days already shot are kept.</p>
      <button type="button" className="ss-go" disabled={running} onClick={start}>{running ? 'Synchronizing…' : '🔄 Synchronize now'}</button>
      {error && <p className="ss-error" role="alert">{error}</p>}
      {job && job.steps.length > 0 && (
        <ul className="sync-steps">
          {job.steps.map((s) => (
            <li key={s.key} className={`sync-step is-${s.state}`}><span aria-hidden="true">{ICON[s.state]}</span> {s.label}{s.note ? <small> — {s.note}</small> : null}</li>
          ))}
        </ul>
      )}
      {job?.status === 'error' && <p className="ss-error" role="alert">Synchronization stopped: {job.error}. Nothing was lost — the previous versions are still there. Press Synchronize to try again.</p>}
      {job?.status === 'done' && (
        <div className="ss-note" role="status">
          <b>Everything now follows the new screenplay.</b>
          {job.cast?.withoutActor?.length > 0 && <p>No actor yet for: {job.cast.withoutActor.join(', ')}.</p>}
          {job.cast?.orphanedActors?.length > 0 && <p>These actors' characters are no longer in the screenplay: {job.cast.orphanedActors.map((o) => `${o.actor} (${o.character})`).join(', ')}.</p>}
        </div>
      )}
    </div>
  )
}
