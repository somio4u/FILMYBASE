import { useCallback, useEffect, useRef, useState } from 'react'
import './SmartScheduler.css'

const ARTIST_CATS = [['costly', 'Costly'], ['normal', 'Normal']]
const LOCATION_CATS = [['free', 'Free'], ['paid', 'Paid']]
const STAGE = { reading: 'Reading the screenplay…', analysing: 'The AI is analysing the screenplay (places, people, what must stay together)…', scheduling: 'Planning the days…' }

async function call(backendUrl, path, options) {
  const response = await fetch(`${backendUrl}/api/smart-scheduler${path}`, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.')
  return data
}

function Segmented({ value, options, onChange }) {
  return (
    <span className="ss-seg">
      {options.map(([key, label]) => (
        <button key={key} type="button" className={`ss-seg-btn ss-${key}${value === key ? ' is-on' : ''}`} onClick={() => onChange(key)}>{label}</button>
      ))}
    </span>
  )
}

// A separate agent (like Adu): it reads a project's approved screenplay and plans the shoot days. It never changes the Production schedule.
// embedded: lives inside Production Management for ONE project (sceneListId) — no start screen, no project picker. Admin only.
export default function SmartScheduler({ backendUrl, onBack, embedded = false, sceneListId = null, projectTitle = '' }) {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState('')
  const [project, setProject] = useState(null) // { sceneListId, title, ... }
  const [brief, setBrief] = useState(null) // { days, maxMinutesPerDay }
  const [artists, setArtists] = useState([])
  const [locations, setLocations] = useState([])
  const [saved, setSaved] = useState('')
  const [latest, setLatest] = useState(null) // { run, stale, changedScenes }
  const [job, setJob] = useState(null) // { stage } while the agent works
  const saveTimer = useRef(null)

  useEffect(() => {
    if (embedded) return
    call(backendUrl, '/projects').then(setProjects).catch((e) => setError(e.message))
  }, [backendUrl, embedded])

  const open = useCallback(async (p) => {
    setProject(p); setError(''); setBrief(null); setLatest(null); setSaved('')
    try {
      const data = await call(backendUrl, `/${p.sceneListId}/brief`)
      setBrief(data.brief); setArtists(data.artists); setLocations(data.locations)
      setLatest(await call(backendUrl, `/${p.sceneListId}/latest`))
    } catch (e) { setError(e.message) }
  }, [backendUrl])

  useEffect(() => {
    if (embedded && sceneListId) open({ sceneListId, title: projectTitle })
  }, [embedded, sceneListId, projectTitle, open])

  // what the owner types is saved by itself, a moment after he stops
  const scheduleSave = (nextBrief, nextArtists, nextLocations) => {
    clearTimeout(saveTimer.current)
    setSaved('')
    saveTimer.current = setTimeout(async () => {
      try {
        await call(backendUrl, `/${project.sceneListId}/brief`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            days: nextBrief.days, maxMinutesPerDay: nextBrief.maxMinutesPerDay,
            artists: Object.fromEntries(nextArtists.map((a) => [a.name, a.category])),
            locations: Object.fromEntries(nextLocations.map((l) => [l.name, l.category])),
          }),
        })
        setSaved('Saved')
      } catch (e) { setSaved(e.message) }
    }, 700)
  }
  const changeBrief = (patch) => { const next = { ...brief, ...patch }; setBrief(next); scheduleSave(next, artists, locations) }
  const changeArtist = (name, category) => { const next = artists.map((a) => (a.name === name ? { ...a, category } : a)); setArtists(next); scheduleSave(brief, next, locations) }
  const changeLocation = (name, category) => { const next = locations.map((l) => (l.name === name ? { ...l, category } : l)); setLocations(next); scheduleSave(brief, artists, next) }

  async function run() {
    setError('')
    clearTimeout(saveTimer.current)
    try {
      // the latest answers are saved first, then the agent reads them
      await call(backendUrl, `/${project.sceneListId}/brief`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: brief.days, maxMinutesPerDay: brief.maxMinutesPerDay, artists: Object.fromEntries(artists.map((a) => [a.name, a.category])), locations: Object.fromEntries(locations.map((l) => [l.name, l.category])) }),
      })
      const { jobId } = await call(backendUrl, `/${project.sceneListId}/run`, { method: 'POST' })
      setJob({ stage: 'reading' })
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const status = await call(backendUrl, `/${project.sceneListId}/run/${jobId}`)
        if (status.status === 'error') throw new Error(status.error || 'The plan could not be made.')
        if (status.status === 'running') { setJob({ stage: status.stage }); continue }
        break
      }
      setLatest(await call(backendUrl, `/${project.sceneListId}/latest`))
    } catch (e) { setError(e.message) }
    setJob(null)
  }

  const run1 = latest?.run
  const catOfArtist = (name) => run1?.artists.find((a) => a.name === name)?.category ?? 'normal'

  return (
    <div className={`ss-page${embedded ? ' ss-embedded' : ''}`}>
      {!embedded && (
        <div className="ss-top">
          <button type="button" className="ss-back" onClick={project ? () => { setProject(null); setError('') } : onBack}>← {project ? 'Projects' : 'Back'}</button>
          <h1>🗓️ Smart Scheduler</h1>
        </div>
      )}
      <p className="ss-sub">A separate agent: it reads a project's approved screenplay and plans the shoot days — fewest days for the costly artists, as few paid-location days and moves as possible. It does not change the Production schedule.</p>
      {error && <p className="ss-error" role="alert">{error}</p>}

      {!embedded && !project && (
        <div className="ss-projects">
          {!projects && !error && <p className="ss-muted">Loading projects…</p>}
          {projects?.length === 0 && <p className="ss-muted">No project has an approved screenplay yet.</p>}
          {projects?.map((p) => (
            <button key={p.sceneListId} type="button" className="ss-project" onClick={() => open(p)}>
              <strong>{p.title}</strong>
              <span>{p.isSeries ? `${p.episodes} episodes` : 'Film'} · {p.scenes} scenes · about {p.minutes} min · {p.written}/{p.scenes} scenes written</span>
              <span className="ss-muted">{p.lastRunAt ? `Last plan: ${new Date(p.lastRunAt).toLocaleString()}` : 'No plan yet'}</span>
            </button>
          ))}
        </div>
      )}

      {project && !brief && !error && <p className="ss-muted">Reading the screenplay…</p>}

      {project && brief && (
        <>
          <h2 className="ss-h2">{project.title}</h2>
          <section className="ss-card">
            <h3>1 · Your brief {saved && <small className="ss-saved">{saved}</small>}</h3>
            <div className="ss-days">
              <label>Days to finish the whole shoot
                <input type="number" min="1" max="60" value={brief.days} onChange={(e) => changeBrief({ days: Number(e.target.value) || 1 })} />
              </label>
              <label>Most minutes of finished film in one day <small>(optional — leave empty and the days are simply balanced)</small>
                <input type="number" min="1" max="120" step="0.5" value={brief.maxMinutesPerDay ?? ''} placeholder="e.g. 10" onChange={(e) => changeBrief({ maxMinutesPerDay: e.target.value === '' ? null : Number(e.target.value) })} />
              </label>
            </div>
            <div className="ss-two">
              <div>
                <h4>Artists — which are costly?</h4>
                <div className="ss-table">
                  {artists.map((a) => (
                    <div key={a.name} className="ss-row">
                      <span className="ss-name">{a.name}<small>{a.scenes} scenes · {a.minutes} min</small></span>
                      <Segmented value={a.category} options={ARTIST_CATS} onChange={(c) => changeArtist(a.name, c)} />
                    </div>
                  ))}
                  {artists.length === 0 && <p className="ss-muted">No artists found yet — the scenes are not written.</p>}
                </div>
              </div>
              <div>
                <h4>Locations — which are free?</h4>
                <div className="ss-table">
                  {locations.map((l) => (
                    <div key={l.name} className="ss-row">
                      <span className="ss-name">{l.name}<small>{l.scenes} scenes · {l.minutes} min</small></span>
                      <Segmented value={l.category} options={LOCATION_CATS} onChange={(c) => changeLocation(l.name, c)} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <p className="ss-muted">Distances between locations, real rupee rates and artists' own available dates can be added later.</p>
            <button type="button" className="ss-go" onClick={run} disabled={Boolean(job)}>{job ? STAGE[job.stage] ?? 'Working…' : latest?.run ? 'Plan again' : 'Analyse and schedule'}</button>
          </section>

          {run1 && (
            <section className="ss-card">
              <h3>2 · The plan <small>made {new Date(run1.createdAt).toLocaleString()} for {run1.input.days} days{run1.aiUsed ? ' · AI analysis used' : ' · without AI analysis'}</small></h3>
              {latest.stale && <p className="ss-stale">The screenplay has changed since this plan ({latest.changedScenes} scene{latest.changedScenes === 1 ? '' : 's'}). Press "Plan again" to include the changes.</p>}
              <div className="ss-stats">
                <div><b>{run1.input.days}</b><span>days</span></div>
                <div><b>{run1.totals.avgDayMinutes}</b><span>min a day (most {run1.totals.maxDayMinutes})</span></div>
                <div><b>{run1.totals.costUnits}</b><span>cost units{run1.totals.savedPercent > 0 ? ` · ${run1.totals.savedPercent}% less than shooting in story order` : ''}</span></div>
                <div><b>{run1.totals.artistDays}</b><span>artist-days</span></div>
                <div><b>{run1.totals.moves}</b><span>company moves</span></div>
              </div>
              {run1.warnings.map((w, i) => <p key={i} className="ss-warn">⚠ {w}</p>)}
              {run1.notes.length > 0 && (
                <div className="ss-notes"><b>What the AI noticed</b><ul>{run1.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
              )}
              {(Object.keys(run1.merged.locations).length > 0 || Object.keys(run1.merged.artists).length > 0 || run1.voiceOnly.length > 0) && (
                <p className="ss-muted">
                  {Object.keys(run1.merged.locations).length > 0 && <>Treated as the same place: {Object.entries(run1.merged.locations).map(([a, c]) => `${a} = ${c}`).join('; ')}. </>}
                  {Object.keys(run1.merged.artists).length > 0 && <>Same person: {Object.entries(run1.merged.artists).map(([a, c]) => `${a} = ${c}`).join('; ')}. </>}
                  {run1.voiceOnly.length > 0 && <>Voice only (no call needed): {run1.voiceOnly.join(', ')}.</>}
                </p>
              )}

              <h4>Artists — fewest days needed</h4>
              <div className="ss-grid">
                <div className="ss-grid-head">Artist</div><div className="ss-grid-head">Days called</div><div className="ss-grid-head">Lowest possible</div><div className="ss-grid-head">Which days</div><div className="ss-grid-head">Cost units</div>
                {run1.artists.map((a) => (
                  <div key={a.name} className="ss-grid-row">
                    <span><i className={`ss-dot ss-${a.category}`} />{a.name}{run1.artistKinds[a.name] ? <small> {run1.artistKinds[a.name]}</small> : null}</span>
                    <span><b>{a.callDays}</b></span><span>{a.lowerBound}</span><span>{a.days.join(', ')}{a.span > a.callDays ? ` (on call across ${a.span} days)` : ''}</span><span>{a.costUnits}</span>
                  </div>
                ))}
              </div>

              <h4>Locations</h4>
              <div className="ss-grid ss-grid-loc">
                <div className="ss-grid-head">Location</div><div className="ss-grid-head">Days</div><div className="ss-grid-head">Which days</div><div className="ss-grid-head">Cost units</div>
                {run1.locations.map((l) => (
                  <div key={l.name} className="ss-grid-row">
                    <span><i className={`ss-dot ss-${l.category}`} />{l.name}</span><span><b>{l.dayCount}</b></span><span>{l.days.join(', ')}</span><span>{l.costUnits}</span>
                  </div>
                ))}
              </div>

              <h4>Day by day</h4>
              <div className="ss-days-list">
                {run1.days.map((d) => (
                  <div key={d.day} className="ss-day">
                    <div className="ss-day-head">
                      <b>Day {d.day}</b>
                      <span>{d.minutes} min · {d.sceneIds.length} scene{d.sceneIds.length === 1 ? '' : 's'}{d.night ? ' · night' : d.mixed ? ' · day and night' : ' · day'}</span>
                      <span className="ss-muted">{d.locations.join(' → ')}</span>
                    </div>
                    <div className="ss-chips">{d.artists.map((a) => <span key={a} className={`ss-chip ss-${catOfArtist(a)}`}>{a}</span>)}</div>
                    <ul className="ss-scenes">
                      {d.sceneIds.map((id) => {
                        const s = run1.scenes[id]
                        return <li key={id}><b>{s.label}</b> · {s.intExt}. {s.location} · {s.timeOfDay} · {s.minutes} min{s.artists.length ? ` · ${s.artists.join(', ')}` : ''}{s.gist ? <span className="ss-muted"> — {s.gist}</span> : null}</li>
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
