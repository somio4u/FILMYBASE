import { useEffect, useState } from 'react'
import './SmartScheduler.css'

// Production Management → "For Assistant Directors": the papers an AD works from, each as PDF and Excel.
// Built from the screenplay, Production Management's shoot schedule (or, when there is none, the Smart Scheduler's plan), the Script Breakdown and the colour tags.
const api = async (backendUrl, path) => {
  const response = await fetch(`${backendUrl}${path}`)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || 'Something went wrong. Please try again.')
  }
  return response
}

export default function AdPapers({ backendUrl, sceneListId, refreshKey }) {
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [saved, setSaved] = useState(null) // { url, name } — a tap-to-save link (phones do not always start a download by themselves)

  useEffect(() => {
    setInfo(null); setError('')
    api(backendUrl, `/api/ad/${sceneListId}/documents`).then((r) => r.json()).then(setInfo).catch((e) => setError(e.message))
  }, [backendUrl, sceneListId, refreshKey])

  async function download(kind, format) {
    setBusy(`${kind}-${format}`); setError('')
    try {
      const response = await api(backendUrl, `/api/ad/${sceneListId}/${kind}/${format}`)
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
        <div className="ss-name"><b>{d.title}</b><small>{d.about}</small>{blocked && <small className="ss-warn">Make the shoot schedule above first.</small>}</div>
        <div className="ss-sugg-act">
          <button type="button" disabled={blocked || Boolean(busy)} onClick={() => download(d.kind, 'pdf')}>{busy === `${d.kind}-pdf` ? 'Making…' : '⬇ PDF'}</button>
          <button type="button" disabled={blocked || Boolean(busy)} onClick={() => download(d.kind, 'xlsx')}>{busy === `${d.kind}-xlsx` ? 'Making…' : '⬇ Excel'}</button>
        </div>
      </div>
    )
  })

  return (
    <div className="ss-ad">
      <p className="ss-sub">The papers an Assistant Director needs to run the shoot without missing anything. Each comes as a PDF to print and an Excel file to edit. Call times, make-up looks and notes are left blank for the AD to fill in.</p>
      {error && <p className="ss-error" role="alert">{error}</p>}
      {!info && !error && <p className="ss-muted">Reading the project…</p>}
      {info && (
        <>
          <p className="ss-muted">Shoot days come from: {info.planSource === 'production' ? 'the Shoot Schedule in Production Management' : info.planSource === 'smart' ? 'the Smart Scheduler plan (no Shoot Schedule yet)' : 'nothing yet'}.</p>
          {!info.hasPlan && <p className="ss-stale">No shoot schedule yet — the day-wise papers (D Sheet, Location-wise Schedule, Call Sheet, Artist-wise Schedule) need one. Make it in the Shoot Schedule above.</p>}
          {info.stale && <p className="ss-stale">The screenplay changed after the Smart Scheduler plan was made, so the day-wise papers may be out of date.</p>}
          {!info.hasBreakdown && <p className="ss-muted">No Script Breakdown yet — props, costume and extras columns will be thin until it is made.</p>}
          {saved && <p className="ss-note">Ready: <a href={saved.url} download={saved.name}>⬇ Tap here to save {saved.name}</a></p>}
          <section className="ss-card"><h3>The three main papers</h3>{render('main')}</section>
          <section className="ss-card"><h3>More for the Assistant Director</h3>{render('more')}</section>
        </>
      )}
    </div>
  )
}
