import { useEffect, useState } from 'react'
import './SmartScheduler.css'

// Post-production → "For Assistant Directors": the papers an AD works from, each as PDF and Excel (built from the screenplay, the Smart Scheduler's plan and the Script Breakdown).
const api = async (backendUrl, path) => {
  const response = await fetch(`${backendUrl}${path}`)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || 'Something went wrong. Please try again.')
  }
  return response
}

export default function PostProduction({ backendUrl, onBack }) {
  const [projects, setProjects] = useState(null)
  const [project, setProject] = useState(null)
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [saved, setSaved] = useState(null) // { url, name } — a tap-to-save link (phones do not always start a download by themselves)

  useEffect(() => {
    api(backendUrl, '/api/smart-scheduler/projects').then((r) => r.json()).then(setProjects).catch((e) => setError(e.message))
  }, [backendUrl])

  async function openProject(p) {
    setProject(p); setInfo(null); setError(''); setSaved(null)
    try { setInfo(await (await api(backendUrl, `/api/ad/${p.sceneListId}/documents`)).json()) } catch (e) { setError(e.message) }
  }

  async function download(kind, format) {
    setBusy(`${kind}-${format}`); setError('')
    try {
      const response = await api(backendUrl, `/api/ad/${project.sceneListId}/${kind}/${format}`)
      const name = (response.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `${kind}.${format}`
      const url = URL.createObjectURL(await response.blob())
      if (saved?.url) URL.revokeObjectURL(saved.url)
      setSaved({ url, name })
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove()
    } catch (e) { setError(e.message) }
    setBusy('')
  }

  const docs = info?.documents ?? []
  const render = (group) => docs.filter((d) => d.group === group).map((d) => {
    const blocked = d.needsPlan && !info.hasPlan
    return (
      <div className="ss-sugg" key={d.kind}>
        <div className="ss-name"><b>{d.title}</b><small>{d.about}</small>{blocked && <small className="ss-warn">Make a plan in the Smart Scheduler first.</small>}</div>
        <div className="ss-sugg-act">
          <button type="button" disabled={blocked || Boolean(busy)} onClick={() => download(d.kind, 'pdf')}>{busy === `${d.kind}-pdf` ? 'Making…' : '⬇ PDF'}</button>
          <button type="button" disabled={blocked || Boolean(busy)} onClick={() => download(d.kind, 'xlsx')}>{busy === `${d.kind}-xlsx` ? 'Making…' : '⬇ Excel'}</button>
        </div>
      </div>
    )
  })

  return (
    <div className="ss-page">
      <div className="ss-top">
        <button type="button" className="ss-back" onClick={project ? () => { setProject(null); setError(''); setSaved(null) } : onBack}>← {project ? 'Projects' : 'Back'}</button>
        <h1>🎞️ Post-production</h1>
      </div>
      {error && <p className="ss-error" role="alert">{error}</p>}
      <h2 className="ss-h2">For Assistant Directors</h2>
      <p className="ss-sub">The papers an AD needs to run the shoot without missing anything. Each one comes as a PDF to print and an Excel file to edit. Call times, dates, make-up looks and notes are left blank for the AD to fill in.</p>

      {!project && (
        <div className="ss-projects">
          {!projects && !error && <p className="ss-muted">Loading projects…</p>}
          {projects?.length === 0 && <p className="ss-muted">No project has an approved screenplay yet.</p>}
          {projects?.map((p) => (
            <button key={p.sceneListId} type="button" className="ss-project" onClick={() => openProject(p)}>
              <strong>{p.title}</strong>
              <span>{p.isSeries ? `${p.episodes} episodes` : 'Film'} · {p.scenes} scenes · {p.written}/{p.scenes} written</span>
              <span className="ss-muted">{p.lastRunAt ? `Smart Scheduler plan: ${new Date(p.lastRunAt).toLocaleString()}` : 'No Smart Scheduler plan yet'}</span>
            </button>
          ))}
        </div>
      )}

      {project && !info && !error && <p className="ss-muted">Reading the project…</p>}
      {project && info && (
        <>
          <h2 className="ss-h2">{info.title}</h2>
          {!info.hasPlan && <p className="ss-stale">No Smart Scheduler plan yet — the day-wise papers (D Sheet, Location-wise Schedule, Call Sheet, Artist-wise Schedule) need one. Make it in the 🗓️ Smart Scheduler, then come back.</p>}
          {info.stale && <p className="ss-stale">The screenplay changed after the last plan. Run the Smart Scheduler again so the day-wise papers are up to date.</p>}
          {!info.hasBreakdown && <p className="ss-muted">No Script Breakdown yet — props, costume and extras columns will be thin until it is run.</p>}
          {saved && <p className="ss-note">Ready: <a href={saved.url} download={saved.name}>⬇ Tap here to save {saved.name}</a></p>}
          <section className="ss-card"><h3>The three main papers</h3>{render('main')}</section>
          <section className="ss-card"><h3>More for the Assistant Director</h3>{render('more')}</section>
        </>
      )}
    </div>
  )
}
