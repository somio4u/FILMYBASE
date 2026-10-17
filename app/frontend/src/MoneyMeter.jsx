import { Fragment, useEffect, useMemo, useState } from 'react'

const TYPE_LABEL = { story: 'Movie', ai_movie: 'AI Movie', production: 'Production', none: 'No project' }
const KIND_LABEL = { text: 'Writing (text)', 'text (estimated)': 'Writing — estimated from saved work', image: 'Pictures', audio: 'Voices', video: 'Video', speech: 'Voices' }
const DAY = 24 * 3600 * 1000

// Admin-only screen: what every project and every user has spent on AI. Dollar amounts are estimates (token counts x list prices).
export default function MoneyMeter({ backendUrl, onBack }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('live')
  const [open, setOpen] = useState(null)
  const [onlySpent, setOnlySpent] = useState(true)
  const [live, setLive] = useState(null)

  const load = async () => {
    setError('')
    try {
      const res = await fetch(`${backendUrl}/api/admin/usage`)
      if (!res.ok) throw new Error(res.status === 403 ? 'Only the admin can open the Money Meter.' : 'Could not load the spend report.')
      setData(await res.json())
    } catch (e) { setError(e.message) }
  }
  useEffect(() => { load() }, [])
  // the Live tab: what is running right now and the latest calls, refreshed every 15 seconds while it is open
  useEffect(() => {
    if (tab !== 'live') return undefined
    let stop = false
    const pull = async () => {
      try {
        const res = await fetch(`${backendUrl}/api/admin/usage/live`)
        if (res.ok && !stop) setLive(await res.json())
      } catch { /* try again on the next tick */ }
    }
    pull()
    const timer = setInterval(pull, 15000)
    return () => { stop = true; clearInterval(timer) }
  }, [tab, backendUrl])

  const rate = data?.inrPerUsd ?? 88
  const usd = (v) => `$${(v ?? 0).toFixed((v ?? 0) >= 100 ? 0 : 2)}`
  const inr = (v) => `≈ ₹${Math.round((v ?? 0) * rate).toLocaleString('en-IN')}`
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
  const time = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')
  const active = (iso) => iso && Date.now() - new Date(iso).getTime() < 7 * DAY

  const projects = useMemo(() => (data?.projects ?? []).filter((p) => p.type !== 'none' || p.totalUsd > 0).filter((p) => !onlySpent || p.totalUsd > 0), [data, onlySpent])
  const maxDaily = Math.max(0.0001, ...(data?.daily ?? []).map((d) => d.usd))

  return (
    <div className="mm-page">
      <div className="mm-top">
        <button type="button" className="mm-back" onClick={onBack}>← Back</button>
        <h1>💰 Money Meter</h1>
        <button type="button" className="mm-refresh" onClick={load}>Refresh</button>
      </div>
      {error && <p className="mm-error" role="alert">{error}</p>}
      {!data && !error && <p className="mm-muted">Loading…</p>}
      {data && (
        <>
          <div className="mm-cards">
            <div className="mm-card mm-card-main"><span>Total spent on AI</span><b>{usd(data.totals.grandUsd)}</b><small>{inr(data.totals.grandUsd)}</small></div>
            <div className="mm-card"><span>Measured since {when(data.trackingStartedAt)}</span><b>{usd(data.totals.trackedUsd)}</b><small>every call, with user + project</small></div>
            <div className="mm-card"><span>Earlier — estimated (Movies / series)</span><b>{usd(data.totals.earlierEstimatedUsd)}</b><small>worked out from saved work</small></div>
            <div className="mm-card"><span>Earlier — AI Movie log</span><b>{usd(data.totals.earlierLoggedUsd)}</b><small>recorded, no user names</small></div>
            <div className="mm-card"><span>Pro model (Gemini 3.1 Pro)</span><b>{usd(data.totals.proMeasuredUsd + data.totals.proEstimatedUsd)}</b><small>{usd(data.totals.proMeasuredUsd)} measured + {usd(data.totals.proEstimatedUsd)} estimated</small></div>
            <div className="mm-card"><span>Projects</span><b>{data.totals.projects}</b><small>{data.projects.filter((p) => p.totalUsd > 0).length} with spend</small></div>
            <div className="mm-card"><span>Users with spend</span><b>{data.totals.usersWithSpend}</b><small>{data.allUsers.length} logins in all</small></div>
          </div>

          <div className="mm-tabs" role="tablist">
            {[['live', 'Live'], ['projects', 'By project'], ['users', 'By user'], ['days', 'Last 30 days']].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>

          {tab === 'live' && (
            <div className="mm-live-view">
              {!live && <p className="mm-muted">Loading…</p>}
              {live && (
                <>
                  <h3>Running right now</h3>
                  {live.running.length ? (
                    <div className="mm-table-wrap"><table className="mm-table">
                      <thead><tr><th>What</th><th>Project / task</th><th>Step</th><th>Started by</th><th>Last sign of life</th></tr></thead>
                      <tbody>{live.running.map((r, i) => <tr key={i}><td>{r.what}</td><td><b>{r.projectName}</b></td><td>{r.step ?? '—'}</td><td>{r.who ?? '—'}</td><td>{time(r.lastSeen)}</td></tr>)}</tbody>
                    </table></div>
                  ) : <p className="mm-muted">Nothing is running at this moment.</p>}

                  <h3>Spent in the last hour</h3>
                  {live.lastHour.length ? (
                    <div className="mm-table-wrap"><table className="mm-table">
                      <thead><tr><th>Project</th><th>User</th><th className="r">Calls</th><th className="r">Spent</th></tr></thead>
                      <tbody>{live.lastHour.map((r, i) => <tr key={i}><td><b>{r.project}</b></td><td>{r.user}</td><td className="r">{r.calls}</td><td className="r"><b>{usd(r.usd)}</b></td></tr>)}</tbody>
                    </table></div>
                  ) : <p className="mm-muted">No AI call in the last hour.</p>}

                  <h3>Latest calls (newest first)</h3>
                  {live.recent.length ? (
                    <div className="mm-table-wrap"><table className="mm-table">
                      <thead><tr><th>Time</th><th>User</th><th>Project</th><th>Kind / model</th><th className="r">Tokens in / out</th><th className="r">Cost</th></tr></thead>
                      <tbody>{live.recent.map((r, i) => <tr key={i}><td>{time(r.at)}</td><td>{r.user}</td><td>{r.project}</td><td>{KIND_LABEL[r.kind] ?? r.kind}<small> · {String(r.model ?? '').replace('gemini-', '')}</small></td><td className="r">{r.promptTokens ?? '—'} / {r.outputTokens ?? '—'}</td><td className="r"><b>${r.usd.toFixed(4)}</b></td></tr>)}</tbody>
                    </table></div>
                  ) : <p className="mm-muted">No call has been recorded yet. Every AI call from now on appears here.</p>}
                  <p className="mm-muted">Refreshes by itself every 15 seconds while this tab is open.</p>
                </>
              )}
            </div>
          )}

          {tab === 'projects' && (
            <>
              <label className="mm-check"><input type="checkbox" checked={onlySpent} onChange={(e) => setOnlySpent(e.target.checked)} /> Only projects that cost something</label>
              <div className="mm-table-wrap">
                <table className="mm-table">
                  <thead><tr><th>Project</th><th>Type</th><th>Started</th><th>Last used</th><th className="r">Calls</th><th className="r">Spent</th></tr></thead>
                  <tbody>
                    {projects.map((p) => (
                      <Fragment key={p.key}>
                        <tr className="mm-row" onClick={() => setOpen(open === p.key ? null : p.key)}>
                          <td><b>{p.name}</b>{p.owner && <small> · by {p.owner}</small>}</td>
                          <td><span className={`mm-badge mm-${p.type}`}>{TYPE_LABEL[p.type] ?? p.type}</span></td>
                          <td>{when(p.createdAt)}</td>
                          <td>{when(p.lastAt)} {active(p.lastAt) && <span className="mm-live">● active</span>}</td>
                          <td className="r">{p.calls}</td>
                          <td className="r"><b>{usd(p.totalUsd)}</b><small> {inr(p.totalUsd)}</small></td>
                        </tr>
                        {open === p.key && (
                          <tr className="mm-detail"><td colSpan={6}>
                            <div className="mm-split">
                              <div><h4>By user</h4>{Object.keys(p.byUser).length ? Object.entries(p.byUser).sort((a, b) => b[1] - a[1]).map(([n, v]) => <p key={n}>{n} — <b>{usd(v)}</b></p>) : <p className="mm-muted">No user recorded yet.</p>}</div>
                              <div><h4>By kind</h4>{Object.keys(p.byKind).length ? Object.entries(p.byKind).sort((a, b) => b[1] - a[1]).map(([n, v]) => <p key={n}>{KIND_LABEL[n] ?? n} — <b>{usd(v)}</b></p>) : <p className="mm-muted">Nothing yet.</p>}</div>
                              <div><h4>Split</h4><p>Measured: <b>{usd(p.trackedUsd)}</b></p><p>Earlier, AI Movie log: <b>{usd(p.earlierLoggedUsd)}</b></p><p>Earlier, estimated: <b>{usd(p.earlierEstimatedUsd)}</b></p></div>
                              {p.estimateStages?.length > 0 && <div className="mm-wide"><h4>Estimated earlier work, by stage</h4>{p.estimateStages.map((st) => <p key={st.stage}>{st.label} — {Math.round(st.rows)} saved × {st.model.replace('gemini-', '')} — <b>{usd(st.usd)}</b></p>)}</div>}
                            </div>
                          </td></tr>
                        )}
                      </Fragment>
                    ))}
                    {!projects.length && <tr><td colSpan={6} className="mm-muted">Nothing recorded yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'users' && (
            <div className="mm-table-wrap">
              <table className="mm-table">
                <thead><tr><th>User</th><th>Last used</th><th className="r">Calls</th><th>Biggest projects</th><th className="r">Spent</th></tr></thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id ?? 'none'}>
                      <td><b>{u.name}</b></td>
                      <td>{when(u.lastAt)}</td>
                      <td className="r">{u.calls}</td>
                      <td>{Object.entries(u.byProject).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, v]) => `${n} ${usd(v)}`).join(' · ') || '—'}</td>
                      <td className="r"><b>{usd(u.trackedUsd)}</b><small> {inr(u.trackedUsd)}</small></td>
                    </tr>
                  ))}
                  {!data.users.length && <tr><td colSpan={5} className="mm-muted">No user has used AI since tracking began.</td></tr>}
                </tbody>
              </table>
              <p className="mm-muted">Logins that have not spent anything: {data.allUsers.filter((u) => !data.users.some((s) => s.id === u.id)).map((u) => u.name).join(', ') || 'none'}.</p>
            </div>
          )}

          {tab === 'days' && (
            <div className="mm-days">
              {data.daily.length ? data.daily.map((d) => (
                <div key={d.day} className="mm-day"><span>{d.day}</span><i style={{ width: `${Math.max(2, (d.usd / maxDaily) * 100)}%` }} /><b>{usd(d.usd)}</b><small>{d.calls} calls</small></div>
              )) : <p className="mm-muted">Nothing measured in the last 30 days.</p>}
            </div>
          )}

          <p className="mm-note">
            How this is worked out: every writing call is priced by its real token count (Flash-Lite ${data.prices['flash-lite'][0]}/{data.prices['flash-lite'][1]}, Flash ${data.prices.flash[0]}/{data.prices.flash[1]}, Pro ${data.prices.pro[0]}/{data.prices.pro[1]} per million tokens in/out); pictures, voices and video use the project money log. These are estimates from list prices, not your Google invoice — compare with the Google billing page now and then. ₹ uses {rate} per $.
            Work done before {when(data.trackingStartedAt)} was not measured live. Movies and series (like your web series) are <b>estimated from what is saved</b>: each saved pitch deck, character sheet, structure, bit sheet, scene list, screenplay scene, breakdown, schedule and chat reply is one AI answer; its size gives the answer's tokens. The rest are assumptions: the prompt is {data.estimateRules.find((r) => r.stage === 'screenplay').inMult}–{data.estimateRules.find((r) => r.stage === 'sceneList').inMult}× the answer plus a fixed part, the model's hidden thinking is added, and every story stage is read once by the Pro judge ({data.estimateJudge.inBase} tokens in, {data.estimateJudge.out + data.estimateJudge.think} out). Versions that were overwritten or deleted, and failed or repeated calls, left nothing behind, so the estimate is more likely too low than too high. Earlier estimates cannot name the user.
          </p>
          <details className="mm-note"><summary>Show the estimate rules</summary>
            <table className="mm-table"><thead><tr><th>Saved item</th><th>Model</th><th className="r">Fixed prompt</th><th className="r">Prompt × answer</th><th className="r">Thinking × answer</th><th>Pro judge</th></tr></thead>
              <tbody>{data.estimateRules.map((r) => <tr key={r.stage}><td>{r.label}</td><td>{r.model.replace('gemini-', '')}</td><td className="r">{r.inBase}</td><td className="r">{r.inMult}×</td><td className="r">{r.think}×</td><td>{r.judge ? 'yes' : '—'}</td></tr>)}</tbody></table>
          </details>
        </>
      )}
    </div>
  )
}
