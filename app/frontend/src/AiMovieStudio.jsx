// AI Movie: the story and screenplay stages that used to exist only in the Film module, plus the Cinematic Director.
//   storyBible  Auto Storyteller: Story Brain (head writer + three critics), your note, approve, and the Pro judge panel.
//   cinematic   AI Cinematic Spectacle & Mass Entertainment Director: ideas for the Story Brain, scene proposals
//               shown next to the original, directions, approve / edit / reject, send to production.
//   language    Odia / Hindi / English conversion, and "Speak here" (microphone to screenplay lines).
// Every paid action says what it costs first, and the backend refuses anything over the project's money limit.
// The quality mode (Economy / Professional / Maximum) and the creative mode (Balanced Cinematic / Mass Spectacle)
// are two separate settings, both shown at the top of every one of these screens.

import { useCallback, useEffect, useRef, useState } from 'react'
import './ProductionDossier.css'
import './Pipeline.css'
import './Studio.css'

export const AI_MOVIE_STUDIO_VIEWS = {
  storyBible: { title: 'Story Bible', intro: 'The Auto Storyteller: the Story Brain designs the whole story, three critics read it, you approve it — and every later stage follows it.' },
  cinematic: { title: 'Cinematic Director', intro: 'The Cinematic Spectacle & Mass Entertainment Director proposes bigger pictures, hero and villain moments and fight choreography. Nothing changes until you approve it.' },
  language: { title: 'Language & Voice', intro: 'Make the screenplay in Odia, Hindi or English, and speak lines straight into a scene.' },
}

async function call(url, method = 'GET', body) {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, data }
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } }
  }
}

const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`

function Notice({ message }) {
  if (!message) return null
  return <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>{message.text}</p>
}

const errorOf = (r) => ({ tone: 'bad', text: r.data?.error || 'Something went wrong.' })

// ---------------------------------------------------------------------------
// A very small Markdown reader for the Story Bible (headings, bold, lists, tables).
// ---------------------------------------------------------------------------

function inline(text, key) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean)
  return parts.map((p, i) => {
    if (p.startsWith('**')) return <strong key={`${key}-${i}`}>{p.slice(2, -2)}</strong>
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <em key={`${key}-${i}`}>{p.slice(1, -1)}</em>
    return p
  })
}

export function MiniMarkdown({ text }) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let list = []
  let table = []
  const flushList = () => { if (list.length) { out.push(<ul key={`ul${out.length}`}>{list.map((l, i) => <li key={i}>{inline(l, i)}</li>)}</ul>); list = [] } }
  const flushTable = () => {
    if (table.length) {
      const rows = table.filter((r) => !/^\|\s*-+/.test(r)).map((r) => r.split('|').slice(1, -1).map((c) => c.trim()))
      out.push(<table key={`tb${out.length}`} className="studio-table"><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{inline(c, j)}</th> : <td key={j}>{inline(c, j)}</td>))}</tr>)}</tbody></table>)
      table = []
    }
  }
  lines.forEach((line, i) => {
    if (line.startsWith('|')) { flushList(); table.push(line); return }
    flushTable()
    if (/^\s*[-*] /.test(line)) { list.push(line.replace(/^\s*[-*] /, '')); return }
    flushList()
    const h = /^(#{1,4}) (.*)$/.exec(line)
    if (h) { const Tag = `h${Math.min(h[1].length + 1, 5)}`; out.push(<Tag key={i}>{inline(h[2], i)}</Tag>); return }
    if (line.trim()) out.push(<p key={i}>{inline(line, i)}</p>)
  })
  flushList(); flushTable()
  return <div className="studio-md">{out}</div>
}

// ---------------------------------------------------------------------------
// Settings bar: quality mode + creative mode + money
// ---------------------------------------------------------------------------

function useSettings(api, projectId) {
  const [settings, setSettings] = useState(null)
  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/ai-settings`)
    if (r.ok) setSettings(r.data)
    return r.ok ? r.data : null
  }, [api, projectId])
  useEffect(() => { load() }, [load])
  return { settings, reload: load }
}

function ModeBar({ api, projectId, settings, onChanged }) {
  const [message, setMessage] = useState(null)
  if (!settings) return null
  async function change(patch) {
    const r = await call(`${api}/${projectId}/ai-settings`, 'PATCH', patch)
    if (!r.ok) setMessage(errorOf(r)); else { setMessage(null); onChanged() }
  }
  const spend = settings.spend
  const pct = spend.limitUsd > 0 ? Math.min(100, Math.round((spend.spentUsd / spend.limitUsd) * 100)) : 100
  const quality = settings.qualityModes.find((q) => q.key === settings.qualityMode)
  return (
    <div className="studio-bar">
      <label className="studio-field">
        Model quality
        <select value={settings.qualityMode} onChange={(e) => change({ qualityMode: e.target.value })}>
          {settings.qualityModes.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}
        </select>
      </label>
      <fieldset className="studio-field studio-segment">
        <legend>Creative mode</legend>
        {settings.creativeModes.map((m) => (
          <button key={m.key} type="button" className={settings.cinematicMode === m.key ? 'studio-seg active' : 'studio-seg'} aria-pressed={settings.cinematicMode === m.key} title={m.blurb} onClick={() => change({ cinematicMode: m.key })}>{m.label}</button>
        ))}
      </fieldset>
      <div className="pipe-money studio-money">
        <span>Money: {usd(spend.spentUsd)} of {usd(spend.limitUsd)}</span>
        <span className="pipe-meter" aria-hidden="true"><span className={pct > 85 ? 'hot' : ''} style={{ width: `${pct}%` }} /></span>
      </div>
      <p className="dossier-fine-print studio-bar-note">{quality?.blurb}</p>
      <details className="studio-models">
        <summary>Which model does each agent use?</summary>
        <table className="studio-table">
          <thead><tr><th>Agent</th><th>Economy</th><th>Professional</th><th>Maximum</th></tr></thead>
          <tbody>
            {settings.routing.map((r) => <tr key={r.agent}><td>{r.agent}</td>{['economy', 'professional', 'maximum'].map((m) => <td key={m} className={m === settings.qualityMode ? 'studio-current' : ''}>{r[m] === 'pro' ? 'Gemini 3.1 Pro' : r[m] === 'flash' ? 'Gemini 2.5 Flash' : 'Gemini 2.5 Flash-Lite'}</td>)}</tr>)}
          </tbody>
        </table>
        <p className="dossier-fine-print">Pictures, voices and video keep their own models (gemini-2.5-flash-image, gemini-2.5-flash-preview-tts, veo-3.1-fast-generate-preview); the rough cut is joined by ffmpeg. Estimated prices: Pro {usd(settings.prices.proCall)} per call, Flash {usd(settings.prices.flashCall)}.</p>
        <Notice message={message} />
      </details>
      <Notice message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The judge panel result (shared by the Story Bible and any other target)
// ---------------------------------------------------------------------------

function JudgeResult({ result }) {
  if (!result) return null
  return (
    <div className="studio-judges" aria-live="polite">
      <p className="dossier-fine-print">{result.cached ? 'Answered from saved results — nothing changed since the last review, so nothing was spent.' : `Reviewed by ${result.models.judges} (judges) and ${result.models.editor} (Script Editor).`}</p>
      <div className="studio-judge-grid">
        {result.judges.map((j) => (
          <section key={j.role} className="studio-judge">
            <h4>{j.label} <span className={j.score >= 7 ? 'studio-score ok' : 'studio-score low'}>{j.score}/10</span></h4>
            <p>{j.verdict}</p>
            {j.problems?.length > 0 && (
              <ul>{j.problems.map((p, i) => <li key={i}><strong>[{p.severity}] {p.where}:</strong> {p.issue} <em>Fix: {p.fix}</em></li>)}</ul>
            )}
          </section>
        ))}
      </div>
      <section className="studio-editor-note">
        <h4>Script Editor — {result.editor.recommendation === 'approve' ? 'ready to approve' : 'needs changes'}</h4>
        <p>{result.editor.summary}</p>
        {result.editor.contradictions?.length > 0 && (
          <><strong>Where the judges disagree</strong><ul>{result.editor.contradictions.map((c, i) => <li key={i}>{c.between}: {c.issue} <em>→ {c.resolution}</em></li>)}</ul></>
        )}
        {result.editor.consolidatedFixes?.length > 0 && (
          <><strong>Targeted corrections</strong><ul>{result.editor.consolidatedFixes.map((f, i) => <li key={i}><span className={`studio-priority ${f.priority}`}>{f.priority}</span> <strong>{f.target}:</strong> {f.fix}</li>)}</ul></>
        )}
        <p className="dossier-fine-print">You decide: nothing here changes the story or the screenplay by itself.</p>
      </section>
    </div>
  )
}

function JudgePanelButton({ api, projectId, target, label, onDone }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [message, setMessage] = useState(null)
  async function run(force) {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/judge-panel`, 'POST', { target, force })
    setBusy(false)
    if (r.ok) { setResult(r.data); onDone?.() } else setMessage(errorOf(r))
  }
  return (
    <div className="studio-judge-panel">
      <div className="pipe-toolbar">
        <button type="button" className="dossier-small-button" disabled={busy} onClick={() => run(false)}>{busy ? 'The judges are reading…' : label}</button>
        {result && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => run(true)}>Judge again</button>}
        <span className="dossier-fine-print">Three independent judges (Story, Audience, Cinematic) and the Script Editor, on Gemini 3.1 Pro — about $0.50. Runs only when you press the button.</span>
      </div>
      <Notice message={message} />
      <JudgeResult result={result} />
    </div>
  )
}

// A short note under each AI Movie story stage: what the Story Judge scored and what it said.
export function StageJudgeNote({ judge }) {
  if (!judge?.versions?.length) return null
  const best = judge.versions.find((v) => v.version === judge.kept) ?? judge.versions[judge.versions.length - 1]
  return (
    <details className="studio-stage-judge">
      <summary>Story Judge ({judge.model || 'Gemini 3.1 Pro'}): {judge.keptScore}/10 {judge.passed ? '— passed' : '— below the pass mark'} · {judge.versions.length} version{judge.versions.length === 1 ? '' : 's'}</summary>
      <p>{best.verdict}</p>
      {best.problems?.length > 0 && <ul>{best.problems.map((p, i) => <li key={i}><strong>[{p.severity}] {p.where}:</strong> {p.issue} <em>Fix: {p.fix}</em></li>)}</ul>}
      <p className="dossier-fine-print">Scores by version: {judge.versions.map((v) => `v${v.version}: ${v.score}`).join(' · ')}. Quality mode: {judge.qualityMode} (up to {judge.maxRevisions} revision{judge.maxRevisions === 1 ? '' : 's'}).</p>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Story Bible
// ---------------------------------------------------------------------------

function StoryBiblePanel({ api, projectId, backendUrl, settings, reloadSettings }) {
  const [view, setView] = useState(null)
  const [idea, setIdea] = useState('')
  const [format, setFormat] = useState({ type: 'film', kind: 'film', runtimeMinutes: 120, episodeCount: 8, episodeMinutes: 20 })
  const [note, setNote] = useState('')
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/story-bible`)
    if (r.ok) setView(r.data)
    return r.ok ? r.data : null
  }, [api, projectId])
  useEffect(() => {
    load()
    call(`${backendUrl}/api/ai-movie/projects/${projectId}`).then((r) => { if (r.ok) setIdea(r.data.pastedText ?? '') })
  }, [load, backendUrl, projectId])
  const running = view?.job?.status === 'running'
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(async () => { const v = await load(); if (v?.job?.status !== 'running') reloadSettings() }, 3000)
    return () => clearInterval(timer)
  }, [running, load, reloadSettings])

  async function design() {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/story-bible/design`, 'POST', { idea, format: format.type === 'series' ? { type: 'series', episodeCount: Number(format.episodeCount), episodeMinutes: Number(format.episodeMinutes) } : { type: 'film', kind: format.kind, runtimeMinutes: Number(format.runtimeMinutes) } })
    setBusy(false)
    if (!r.ok) setMessage(errorOf(r)); else load()
  }
  async function sendNote() {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/story-bible/note`, 'POST', { note })
    setBusy(false)
    if (!r.ok) setMessage(errorOf(r)); else { setNote(''); load() }
  }
  async function approve() {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/story-bible/approve`, 'POST')
    setBusy(false)
    if (!r.ok) setMessage(errorOf(r)); else { setMessage({ tone: 'good', text: 'Story Bible approved. Every later stage now follows it.' }); load() }
  }

  if (!view) return <p className="dossier-note">Loading…</p>
  const bible = view.bible
  const review = bible?.review
  return (
    <div className="pipe-panel studio-panel">
      {!bible && (
        <section className="studio-card">
          <h3>1. Your story idea</h3>
          <textarea className="studio-idea" value={idea} onChange={(e) => setIdea(e.target.value)} rows={5} placeholder="Write the story idea here — who it is about, what they want, what stands in the way." disabled={running} />
          <div className="pipe-toolbar">
            <label className="studio-field">Format
              <select
                value={format.type === 'series' ? 'series' : format.kind}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'series') setFormat({ ...format, type: 'series' })
                  else if (v === 'short_film') setFormat({ ...format, type: 'film', kind: 'short_film', runtimeMinutes: Math.min(10, Math.max(1, Number(format.runtimeMinutes) > 10 ? 5 : Number(format.runtimeMinutes) || 5)) })
                  else setFormat({ ...format, type: 'film', kind: 'film', runtimeMinutes: Number(format.runtimeMinutes) > 10 ? format.runtimeMinutes : 90 })
                }}
                disabled={running}
              >
                <option value="short_film">Short film / short drama (1–10 minutes)</option>
                <option value="film">Film (its own length)</option>
                <option value="series">Web series</option>
              </select>
            </label>
            {format.type === 'film'
              ? <label className="studio-field">Total minutes{format.kind === 'short_film' ? ' (1–10)' : ''}<input type="number" min={format.kind === 'short_film' ? 1 : 11} max={format.kind === 'short_film' ? 10 : 300} step={format.kind === 'short_film' ? 0.5 : 1} value={format.runtimeMinutes} onChange={(e) => setFormat({ ...format, runtimeMinutes: e.target.value })} disabled={running} /></label>
              : <>
                <label className="studio-field">Episodes<input type="number" min="2" max="60" value={format.episodeCount} onChange={(e) => setFormat({ ...format, episodeCount: e.target.value })} disabled={running} /></label>
                <label className="studio-field">Minutes each<input type="number" min="3" max="90" value={format.episodeMinutes} onChange={(e) => setFormat({ ...format, episodeMinutes: e.target.value })} disabled={running} /></label>
              </>}
            <button type="button" className="dossier-small-button" disabled={busy || running || !idea.trim()} onClick={design}>{running ? 'The Story Brain is working…' : 'Design the Story Bible'}</button>
          </div>
          <p className="dossier-fine-print">The Story Brain pitches three directions, an audience critic picks one, then the head writer designs the whole story and three critics (Story Doctor, Audience Critic, Odisha Culture Expert) read it. This is the biggest AI job: Gemini 3.1 Pro, about $1.50, a few minutes.</p>
        </section>
      )}

      {(running || view.job?.notes?.length > 0) && (
        <section className="studio-card" aria-live="polite">
          <h3>{running ? (view.job.title || 'The Story Brain is working') : 'What the Story Brain did'}</h3>
          <ol className="studio-notes">{(view.job.notes ?? []).map((n, i) => <li key={i}>{n}</li>)}</ol>
          {view.job?.status === 'failed' && <p className="dossier-error" role="alert">{view.job.error}</p>}
        </section>
      )}

      {bible && (
        <>
          <section className="studio-card">
            <div className="studio-title-row">
              <h3>{bible.promise?.title ?? 'Story Bible'}</h3>
              {view.status === 'approved' ? <span className="dossier-badge edited">Approved</span> : <span className="dossier-badge stale">Waiting for your approval</span>}
              <a className="dossier-small-button studio-link" href={`${api}/${projectId}/story-bible.html`} target="_blank" rel="noreferrer">Open printable page</a>
            </div>
            {review && (
              <div className="studio-scores">
                {Object.entries(review.scores).map(([key, score]) => <span key={key} className={score >= view.passScore ? 'studio-score ok' : 'studio-score low'}>{{ storyDoctor: 'Story Doctor', audienceCritic: 'Audience Critic', cultureExpert: 'Odisha Culture Expert' }[key] ?? key}: {score}/10</span>)}
                <span className="dossier-fine-print">{review.passed ? 'The critics passed it.' : `Not every critic reached ${view.passScore} — read the open problems below, then give a note or approve it as it is.`}</span>
              </div>
            )}
            <details open className="studio-bible"><summary>Read the Story Bible</summary><MiniMarkdown text={view.markdown} /></details>
          </section>

          {view.status !== 'approved' && (
            <section className="studio-card">
              <h3>Your decision</h3>
              <textarea className="studio-idea" value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Want something changed? Write a note, e.g. “Make the villain her own sister.” The head writer follows it and the critics read it again." disabled={running} />
              <div className="pipe-toolbar">
                <button type="button" className="dossier-small-button" disabled={busy || running || !note.trim()} onClick={sendNote}>Send my note to the Story Brain</button>
                <button type="button" className="dossier-small-button studio-approve" disabled={busy || running} onClick={approve}>Approve the Story Bible</button>
              </div>
            </section>
          )}

          <section className="studio-card">
            <h3>Judges</h3>
            <JudgePanelButton api={api} projectId={projectId} target="bible" label="Ask the judges to review the Story Bible" onDone={reloadSettings} />
          </section>
        </>
      )}
      <Notice message={message} />
      <p className="dossier-fine-print">Next: the Story stages (Synopsis, Characters, Three-Act, Beat Sheet) in the left menu are written following this Bible, each one scored by the Story Judge on Gemini 3.1 Pro.{settings ? ` Quality mode: ${settings.qualityMode}.` : ''}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cinematic Director
// ---------------------------------------------------------------------------

const LEVEL_LABEL = { none: 'No spectacle needed', light: 'Light', major: 'Major', signature: 'Signature moment' }

function BlocksEditor({ blocks, onChange }) {
  const update = (i, patch) => onChange(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)))
  return (
    <ol className="studio-blocks">
      {blocks.map((b, i) => (
        <li key={i}>
          <select aria-label="Line type" value={b.type} onChange={(e) => update(i, { type: e.target.value })}><option value="action">Action</option><option value="dialogue">Dialogue</option></select>
          {b.type === 'dialogue' && <input aria-label="Character" className="studio-char" value={b.character ?? ''} onChange={(e) => update(i, { character: e.target.value.toUpperCase() })} placeholder="CHARACTER" />}
          <textarea aria-label="Text" value={b.text} rows={2} onChange={(e) => update(i, { text: e.target.value })} />
          <button type="button" className="dossier-small-button" onClick={() => onChange(blocks.filter((_, j) => j !== i))}>Remove</button>
        </li>
      ))}
      <li><button type="button" className="dossier-small-button" onClick={() => onChange([...blocks, { type: 'action', character: '', parenthetical: '', text: '' }])}>Add a line</button></li>
    </ol>
  )
}

function DirectionItem({ item, onDecide, onEdit, busy }) {
  const [editing, setEditing] = useState(false)
  const [fields, setFields] = useState({ purpose: item.payload.purpose ?? '', heroIntroduction: item.payload.heroIntroduction ?? '', villainPresentation: item.payload.villainPresentation ?? '' })
  const decided = ['approved', 'rejected', 'applied', 'sent'].includes(item.status)
  return (
    <article className={`studio-item ${item.stale ? 'stale' : ''} ${item.status}`}>
      <header className="studio-item-head">
        <strong>Directions</strong>
        <span className={`studio-level ${item.payload.spectacleLevel}`}>{LEVEL_LABEL[item.payload.spectacleLevel] ?? item.payload.spectacleLevel}</span>
        <StatusBadge item={item} />
      </header>
      {editing ? (
        <div className="studio-edit">
          {[['purpose', 'What the scene is for'], ['heroIntroduction', 'Hero introduction'], ['villainPresentation', 'Villain presentation']].map(([key, label]) => (
            <label key={key} className="studio-field">{label}<textarea rows={2} value={fields[key]} onChange={(e) => setFields({ ...fields, [key]: e.target.value })} /></label>
          ))}
          <div className="pipe-card-buttons">
            <button type="button" className="dossier-small-button" disabled={busy} onClick={async () => { if (await onEdit(item, fields)) setEditing(false) }}>Save my edits</button>
            <button type="button" className="dossier-small-button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <pre className="studio-direction">{item.directionText}</pre>
      )}
      {item.payload.newAssets?.length > 0 && <p className="dossier-fine-print">New production assets this needs: {item.payload.newAssets.map((a) => `${a.name} (${a.kind})`).join(', ')}</p>}
      {item.edited && <p className="dossier-fine-print">Edited by you.</p>}
      {item.waitingForChange && <p className="dossier-fine-print">Made for the proposed rewrite of this scene — decide on the rewrite first.</p>}
      {item.stale && <p className="dossier-error">The scene changed after the Director looked at it, so this is out of date and will not go to production. Ask the Director to look at the scene again.</p>}
      {!item.stale && (
        <div className="pipe-card-buttons">
          {item.status !== 'approved' && item.status !== 'sent' && <button type="button" className="dossier-small-button studio-approve" disabled={busy || item.waitingForChange} onClick={() => onDecide(item, 'approve')}>Approve</button>}
          {item.status === 'pending' && !editing && <button type="button" className="dossier-small-button" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
          {!decided || item.status === 'approved' ? <button type="button" className="dossier-small-button" disabled={busy} onClick={() => onDecide(item, 'reject')}>Reject</button> : null}
        </div>
      )}
    </article>
  )
}

function StatusBadge({ item }) {
  if (item.stale) return <span className="dossier-badge stale">Out of date</span>
  if (item.status === 'approved' || item.status === 'applied') return <span className="dossier-badge edited">{item.status === 'applied' ? 'Applied to the screenplay' : 'Approved'}</span>
  if (item.status === 'sent') return <span className="dossier-badge edited">Sent</span>
  if (item.status === 'rejected') return <span className="dossier-badge issues">Rejected</span>
  return <span className="dossier-badge">Waiting for you</span>
}

function ChangeItem({ item, onDecide, onEdit, busy }) {
  const [editing, setEditing] = useState(false)
  const [blocks, setBlocks] = useState(item.payload.enhancedBlocks ?? [])
  const [heading, setHeading] = useState(item.payload.enhancedHeading ?? '')
  const open = item.status === 'pending' && !item.stale
  return (
    <article className={`studio-item change ${item.stale ? 'stale' : ''} ${item.status}`}>
      <header className="studio-item-head">
        <strong>Proposed rewrite of the scene</strong>
        <StatusBadge item={item} />
      </header>
      <div className="studio-compare">
        <section aria-label="Original scene"><h4>Original</h4><pre>{item.originalText}</pre></section>
        <section aria-label="Enhanced scene">
          <h4>Enhanced</h4>
          {editing ? (
            <>
              <input aria-label="Scene heading" className="studio-heading-input" value={heading} onChange={(e) => setHeading(e.target.value)} />
              <BlocksEditor blocks={blocks} onChange={setBlocks} />
            </>
          ) : <pre>{item.enhancedText}</pre>}
        </section>
      </div>
      {item.payload.dialogueToAction?.length > 0 && !editing && (
        <p className="dossier-fine-print">Talk turned into picture: {item.payload.dialogueToAction.map((d) => `“${d.original}” → ${d.replacement}`).join(' · ')}</p>
      )}
      {item.stale && <p className="dossier-error">The scene changed after this was proposed, so it cannot be applied. Ask the Director to look at the scene again.</p>}
      {open && (
        <div className="pipe-card-buttons">
          {editing
            ? <>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={async () => { if (await onEdit(item, { enhancedHeading: heading, enhancedBlocks: blocks })) setEditing(false) }}>Save my edits</button>
              <button type="button" className="dossier-small-button" onClick={() => setEditing(false)}>Cancel</button>
            </>
            : <>
              <button type="button" className="dossier-small-button studio-approve" disabled={busy} onClick={() => onDecide(item, 'approve')}>Approve and use this scene</button>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={() => setEditing(true)}>Edit first</button>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={() => onDecide(item, 'reject')}>Reject</button>
            </>}
        </div>
      )}
      {open && !editing && <p className="dossier-fine-print">Approving replaces this scene in the screenplay and puts its beat back into your normal screenplay review.</p>}
    </article>
  )
}

function CinematicPanel({ api, projectId, settings, reloadSettings }) {
  const [view, setView] = useState(null)
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState({})
  const [sent, setSent] = useState(null)

  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/cinematic`)
    if (r.ok) setView(r.data)
    return r.ok ? r.data : null
  }, [api, projectId])
  useEffect(() => { load() }, [load])
  const running = view?.job?.status === 'running'
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(async () => { const v = await load(); if (v?.job?.status !== 'running') reloadSettings() }, 3000)
    return () => clearInterval(timer)
  }, [running, load, reloadSettings])

  async function act(url, body, okText) {
    setBusy(true); setMessage(null)
    const r = await call(url, 'POST', body)
    setBusy(false)
    if (!r.ok) { setMessage(errorOf(r)); return null }
    if (okText) setMessage({ tone: 'good', text: okText(r.data) })
    await load(); reloadSettings()
    return r.data
  }
  const decide = (item, what) => act(`${api}/${projectId}/cinematic/items/${item.id}/${what}`, undefined, (d) => (d.reviewReopened ? 'The scene was replaced. Its beat is back in your screenplay review — approve the screenplay again when you are happy.' : null))
  async function edit(item, payload) {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/cinematic/items/${item.id}`, 'PATCH', { payload })
    setBusy(false)
    if (!r.ok) { setMessage(errorOf(r)); return false }
    await load()
    return true
  }

  if (!view) return <p className="dossier-note">Loading…</p>
  const recs = view.items.filter((i) => i.kind === 'story_rec' && ['pending', 'approved', 'sent'].includes(i.status))
  const byScene = new Map()
  view.items.filter((i) => i.kind !== 'story_rec').forEach((i) => { byScene.set(i.sceneKey, [...(byScene.get(i.sceneKey) ?? []), i]) })
  const headings = Object.fromEntries(view.scenes.map((s) => [s.key, s.heading]))
  const pickedIds = Object.entries(picked).filter(([, on]) => on).map(([id]) => Number(id))

  return (
    <div className="pipe-panel studio-panel">
      <section className="studio-card">
        <h3>1. Ideas for the story</h3>
        <p className="dossier-fine-print">The Director reads the approved Story Bible and suggests stronger hero and villain moments, signature action and a bigger climax. It never edits the Bible — your picks go to the Story Brain (head writer and critics) as a note.</p>
        <div className="pipe-toolbar">
          <button type="button" className="dossier-small-button" disabled={busy} onClick={() => act(`${api}/${projectId}/cinematic/story-recommendations`, {}, (d) => `The Director made ${d.created} recommendations.`)}>Ask the Director to read the Story Bible</button>
          <span className="dossier-fine-print">Gemini 3.1 Pro · about $0.12</span>
        </div>
        {recs.length > 0 && (
          <>
            <ul className="studio-recs">
              {recs.map((r) => (
                <li key={r.id} className={r.status}>
                  <label>
                    <input type="checkbox" checked={Boolean(picked[r.id])} disabled={r.status === 'sent'} onChange={(e) => setPicked({ ...picked, [r.id]: e.target.checked })} />
                    <span><strong>{r.title}</strong> <span className="dossier-fine-print">({String(r.payload.area).replace(/_/g, ' ')})</span>{r.status === 'sent' && <span className="dossier-badge edited"> Sent to Story Brain</span>}</span>
                  </label>
                  <p>{r.summary}</p>
                  <p className="dossier-fine-print">Why it works: {r.payload.whyItWorks} · Risk: {r.payload.storyRisk}</p>
                </li>
              ))}
            </ul>
            <button type="button" className="dossier-small-button" disabled={busy || pickedIds.length === 0} onClick={async () => { const d = await act(`${api}/${projectId}/cinematic/story-recommendations/send`, { ids: pickedIds }, (x) => `Sent ${x.sent} to the Story Brain. Open the Story Bible to see its revision.`); if (d) setPicked({}) }}>Send the ticked ideas to the Story Brain</button>
          </>
        )}
      </section>

      <section className="studio-card">
        <h3>2. The screenplay</h3>
        <p className="dossier-fine-print">
          {view.screenplayApproved
            ? 'The screenplay is approved, so the Director only gives directions for shooting it — the Cinematic Enhancement Pass. It will not propose rewrites.'
            : 'While you are still developing the screenplay, the Director can also propose a rewritten scene next to the original. Nothing changes until you approve it.'}
          {' '}Only scenes that have changed or have no directions yet are paid for again.
        </p>
        <div className="pipe-toolbar">
          <button type="button" className="dossier-small-button" disabled={busy || running || view.sceneCount === 0} onClick={() => act(`${api}/${projectId}/cinematic/analyze`, {}, (d) => (d.started ? `The Director is reading ${d.scenes} scene${d.scenes === 1 ? '' : 's'}.` : d.reason))}>{running ? `Reading scenes… ${view.job.done ?? 0}/${view.job.total ?? '?'}` : view.screenplayApproved ? 'Run the cinematic enhancement pass' : 'Ask the Director to read the screenplay'}</button>
          {view.sceneCount === 0 && <span className="dossier-fine-print">Write the screenplay first.</span>}
          <span className="dossier-fine-print">{view.model} · about $0.12 per scene</span>
        </div>
        {view.job?.stoppedBy === 'money_limit' && <p className="dossier-error" role="alert">The Director stopped because the money limit was reached. {view.job.error}</p>}
        {view.job?.status === 'failed' && <p className="dossier-error" role="alert">{view.job.error}</p>}
        {[...byScene.entries()].map(([key, items]) => (
          <div key={key} className="studio-scene">
            <h4>{headings[key] || key}</h4>
            {items.filter((i) => i.kind === 'screenplay_change').map((i) => <ChangeItem key={i.id} item={i} onDecide={decide} onEdit={edit} busy={busy} />)}
            {items.filter((i) => i.kind === 'cinematic_direction').map((i) => <DirectionItem key={i.id} item={i} onDecide={decide} onEdit={edit} busy={busy} />)}
          </div>
        ))}
      </section>

      <section className="studio-card">
        <h3>3. Send to production</h3>
        <p className="dossier-fine-print">{view.counts.approvedDirections} approved direction{view.counts.approvedDirections === 1 ? '' : 's'} ready · {view.counts.pending} waiting for you · {view.counts.stale} out of date (never sent). Approved directions reach the Silent Agent (extra props, costumes, places) and the Shot Cutter (shots, camera, continuity).</p>
        <button type="button" className="dossier-small-button studio-approve" disabled={busy || !view.screenplayApproved} onClick={async () => { const d = await act(`${api}/${projectId}/cinematic/send-to-production`, {}, null); if (d) setSent(d) }}>Send the approved screenplay and directions to production</button>
        {!view.screenplayApproved && <p className="dossier-fine-print">Approve the final screenplay first (Screenplay stage in the left menu).</p>}
        {sent && <p className="dossier-message" role="status">Sent {sent.sentDirections} direction{sent.sentDirections === 1 ? '' : 's'} to production{sent.assetsRefreshed ? ' and refreshed the asset list' : ' (the asset list could not be refreshed — try again)'}. {sent.skippedStale > 0 ? `${sent.skippedStale} out-of-date one${sent.skippedStale === 1 ? ' was' : 's were'} skipped. ` : ''}{sent.stillUnreviewed > 0 ? `${sent.stillUnreviewed} still waiting for your decision.` : ''}</p>}
      </section>

      <section className="studio-card">
        <h3>Judges</h3>
        <JudgePanelButton api={api} projectId={projectId} target="screenplay" label="Ask the judges to review the screenplay" onDone={reloadSettings} />
      </section>
      <Notice message={message} />
      {settings && <p className="dossier-fine-print">Creative mode: {settings.cinematicMode === 'mass' ? 'Mass Spectacle' : 'Balanced Cinematic'} · Model quality: {settings.qualityMode}. These are separate settings.</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Language & Voice
// ---------------------------------------------------------------------------

function useRecorder() {
  const [phase, setPhase] = useState('idle')
  const recorder = useRef(null)
  const chunks = useRef([])
  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record. Try Chrome or Safari.')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = new MediaRecorder(stream)
    chunks.current = []
    rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
    recorder.current = rec
    rec.start()
    setPhase('recording')
  }
  function stop() {
    return new Promise((resolve) => {
      const rec = recorder.current
      if (!rec) return resolve(null)
      rec.onstop = () => {
        rec.stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })
        const reader = new FileReader()
        reader.onloadend = () => { setPhase('idle'); resolve({ audio: String(reader.result).split(',')[1], mimeType: blob.type || 'audio/webm' }) }
        reader.readAsDataURL(blob)
      }
      setPhase('sending')
      rec.stop()
    })
  }
  return { phase, start, stop }
}

function sceneToBlocks(scene, lang) {
  if (Array.isArray(scene.content) && scene.content.length > 0) {
    return scene.content.map((b) => (b.type === 'dialogue'
      ? { type: 'dialogue', character: b.character ?? '', parenthetical: b.parenthetical?.[lang] ?? '', text: b.line?.[lang] ?? '' }
      : b.type === 'transition' ? { type: 'transition', character: '', parenthetical: '', text: b.transition ?? '' }
      : { type: 'action', character: '', parenthetical: '', text: b.text?.[lang] ?? '' }))
  }
  return [
    ...(scene.action ? [{ type: 'action', character: '', parenthetical: '', text: scene.action[lang] ?? '' }] : []),
    ...(scene.dialogue ?? []).map((d) => ({ type: 'dialogue', character: d.character ?? '', parenthetical: '', text: d.line?.[lang] ?? '' })),
  ]
}

function LanguagePanel({ api, projectId, backendUrl }) {
  const [info, setInfo] = useState(null)
  const [scenes, setScenes] = useState([])
  const [language, setLanguage] = useState('or')
  const [scope, setScope] = useState('all')
  const [sceneKey, setSceneKey] = useState('')
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  // speak here
  const [voiceKey, setVoiceKey] = useState('')
  const [voiceLang, setVoiceLang] = useState('en')
  const [draft, setDraft] = useState(null)
  const [voiceNote, setVoiceNote] = useState(null)
  const recorder = useRecorder()

  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/language`)
    if (r.ok) setInfo(r.data)
  }, [api, projectId])
  const loadScenes = useCallback(async () => {
    const r = await call(`${backendUrl}/api/ai-movie/projects/${projectId}`)
    if (!r.ok) return
    const list = []
    ;(r.data.backfill?.screenplayBeats ?? []).forEach((beat, b) => (beat.scenes ?? []).forEach((scene, s) => list.push({ key: `b${b}s${s}`, b, s, scene, heading: scene.sceneHeading?.en ?? `Beat ${b + 1}, scene ${s + 1}` })))
    setScenes(list)
  }, [backendUrl, projectId])
  useEffect(() => { load(); loadScenes() }, [load, loadScenes])

  const sel = scenes.find((s) => s.key === sceneKey)
  async function convert() {
    setBusy(true); setMessage(null); setResult(null)
    const body = { language, scope: scope === 'scene' ? 'scene' : 'all', ...(scope === 'scene' && sel ? { beatIndex: sel.b, sceneIndex: sel.s } : {}) }
    const r = await call(`${api}/${projectId}/language/convert`, 'POST', body)
    setBusy(false)
    if (!r.ok) { setMessage(errorOf(r)); return }
    setResult(r.data)
    load()
  }

  const vsel = scenes.find((s) => s.key === voiceKey)
  useEffect(() => { setDraft(vsel ? sceneToBlocks(vsel.scene, voiceLang) : null); setVoiceNote(null) }, [voiceKey, voiceLang]) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleRecord() {
    setMessage(null)
    try {
      if (recorder.phase === 'idle') { await recorder.start(); return }
      const clip = await recorder.stop()
      if (!clip) return
      const r = await call(`${api}/${projectId}/scene/voice`, 'POST', { ...clip, beatIndex: vsel.b, sceneIndex: vsel.s, language: voiceLang, draftBlocks: draft })
      if (!r.ok) { setMessage(errorOf(r)); return }
      if (Array.isArray(r.data.fullElements)) {
        // the agent may add, change or remove lines, take a character out, or write the scene again: the draft becomes its result
        setDraft(r.data.fullElements.map((e) => ({ type: e.type, character: e.character ?? '', parenthetical: e.parenthetical ?? '', text: e.text })))
      } else {
        const at = Math.max(0, Math.min(draft.length, r.data.insertAfter))
        setDraft([...draft.slice(0, at), ...r.data.elements.map((e) => ({ type: e.type, character: e.character ?? '', parenthetical: e.parenthetical ?? '', text: e.text })), ...draft.slice(at)])
      }
      const c = r.data.changes
      const did = c ? [c.rewrote ? 'wrote the scene again' : null, c.added ? `added ${c.added}` : null, c.changed ? `changed ${c.changed}` : null, c.removed ? `removed ${c.removed}` : null].filter(Boolean).join(', ') : ''
      setVoiceNote(`You said: “${r.data.transcript}” — ${r.data.note}${did ? ` (${did} line${c.added + c.changed + c.removed === 1 ? '' : 's'}; press Save the scene to keep it)` : ''}`)
    } catch (error) {
      setMessage({ tone: 'bad', text: error.message || 'The microphone did not work.' })
    }
  }
  async function saveScene() {
    setBusy(true); setMessage(null)
    const blocks = draft.filter((b) => b.text.trim()).map((b) => (b.type === 'dialogue' ? { type: 'dialogue', character: b.character, line: b.text, parenthetical: b.parenthetical } : b.type === 'transition' ? { type: 'transition', transition: b.text } : { type: 'action', text: b.text }))
    const r = await call(`${backendUrl}/api/ai-movie/stages/screenplay/beats/${vsel.b}/scenes/${vsel.s}/edit`, 'POST', { projectId, language: voiceLang, sceneHeading: vsel.heading, blocks })
    setBusy(false)
    if (!r.ok) { setMessage(errorOf(r)); return }
    setMessage({ tone: 'good', text: `Scene saved. ${r.data.fixes?.length ? `The checker made ${r.data.fixes.length} small fix${r.data.fixes.length === 1 ? '' : 'es'}.` : ''} Its beat needs your normal approval again if you had approved it.` })
    loadScenes()
  }

  if (!info) return <p className="dossier-note">Loading…</p>
  const exportUrl = (lang) => `${api}/${projectId}/language/export?language=${lang}`
  return (
    <div className="pipe-panel studio-panel">
      <section className="studio-card">
        <h3>Screenplay language</h3>
        <p className="dossier-fine-print">Every scene already has English and Hindi side by side (switch at the top of the left menu). Odia is made here from the English scene, checked, and kept until the scene changes.</p>
        <div className="pipe-toolbar">
          <label className="studio-field">Make it in
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="or">Odia</option><option value="hi">Hindi</option><option value="en">English</option>
            </select>
          </label>
          <label className="studio-field">For
            <select value={scope} onChange={(e) => setScope(e.target.value)}><option value="all">The whole screenplay</option><option value="scene">One scene</option></select>
          </label>
          {scope === 'scene' && (
            <label className="studio-field">Scene
              <select value={sceneKey} onChange={(e) => setSceneKey(e.target.value)}><option value="">Choose a scene…</option>{scenes.map((s) => <option key={s.key} value={s.key}>{s.heading}</option>)}</select>
            </label>
          )}
          <button type="button" className="dossier-small-button" disabled={busy || info.sceneCount === 0 || (scope === 'scene' && !sel)} onClick={convert}>{busy ? 'Converting…' : 'Convert'}</button>
        </div>
        {info.sceneCount === 0 && <p className="dossier-fine-print">Write at least one screenplay scene first.</p>}
        {result?.alreadyInside && <p className="dossier-message" role="status">{result.note}</p>}
        {result && !result.alreadyInside && (
          <p className="dossier-message" role="status">Converted {result.converted} scene{result.converted === 1 ? '' : 's'}.{result.withIssues > 0 ? ` ${result.withIssues} still have problems — see below.` : ' Every one passed the checks.'}{result.stoppedByMoneyLimit ? ' Stopped: the money limit was reached.' : ''}</p>
        )}
        {info.conversions.length > 0 && (
          <table className="studio-table">
            <thead><tr><th>Scene</th><th>Language</th><th>Checks</th></tr></thead>
            <tbody>
              {info.conversions.map((c) => (
                <tr key={`${c.sceneKey}-${c.language}`}>
                  <td>{scenes.find((s) => s.key === c.sceneKey)?.heading ?? c.sceneKey}</td>
                  <td>{c.language === 'or' ? 'Odia' : c.language}</td>
                  <td>{c.outOfDate ? <span className="dossier-badge stale">Out of date — the English scene changed</span> : c.issues.length ? <span className="dossier-badge issues" title={c.issues.map((i) => i.problem).join('\n')}>{c.issues.length} problem{c.issues.length === 1 ? '' : 's'}: {c.issues[0].problem}</span> : <span className="dossier-badge edited">{c.spokenChecked ? 'Checked, natural spoken language' : 'Checked'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="pipe-toolbar"><a className="dossier-small-button studio-link" href={exportUrl('or')} target="_blank" rel="noreferrer">Open the Odia screenplay (text)</a><a className="dossier-small-button studio-link" href={exportUrl('en')} target="_blank" rel="noreferrer">Open the English screenplay (text)</a></p>
      </section>

      <section className="studio-card">
        <h3>Speak here</h3>
        <p className="dossier-fine-print">Pick a scene, press the microphone and speak — in Odia, Hindi or English, or a mix. Your words become screenplay lines in the draft below; nothing is saved until you press “Save the scene”.</p>
        <div className="pipe-toolbar">
          <label className="studio-field">Scene
            <select value={voiceKey} onChange={(e) => setVoiceKey(e.target.value)}><option value="">Choose a scene…</option>{scenes.map((s) => <option key={s.key} value={s.key}>{s.heading}</option>)}</select>
          </label>
          <label className="studio-field">Language of this scene
            <select value={voiceLang} onChange={(e) => setVoiceLang(e.target.value)}><option value="en">English</option><option value="hi">Hindi</option></select>
          </label>
        </div>
        {draft && (
          <>
            <BlocksEditor blocks={draft} onChange={setDraft} />
            <div className="pipe-toolbar">
              <button type="button" className={recorder.phase === 'recording' ? 'dossier-small-button studio-rec' : 'dossier-small-button'} disabled={recorder.phase === 'sending'} aria-pressed={recorder.phase === 'recording'} onClick={toggleRecord}>
                {recorder.phase === 'idle' ? '🎤 Speak here' : recorder.phase === 'recording' ? '⏹ Stop' : 'Listening to your recording…'}
              </button>
              <button type="button" className="dossier-small-button studio-approve" disabled={busy || draft.every((b) => !b.text.trim())} onClick={saveScene}>Save the scene</button>
            </div>
            {voiceNote && <p className="dossier-message" role="status">{voiceNote}</p>}
          </>
        )}
      </section>
      <Notice message={message} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export default function AiMovieStudio({ view, projectId, backendUrl }) {
  const api = `${backendUrl}/api/ai-movie/projects`
  const { settings, reload } = useSettings(api, projectId)
  if (!projectId) return <p className="dossier-note">Open or create an AI Movie project first.</p>
  const info = AI_MOVIE_STUDIO_VIEWS[view]
  return (
    <div className="dossier studio" key={`${view}-${projectId}`}>
      <header className="dossier-header">
        <div>
          <h2>{info.title}</h2>
          <p className="dossier-fine-print">{info.intro}</p>
        </div>
      </header>
      <ModeBar api={api} projectId={projectId} settings={settings} onChanged={reload} />
      {view === 'storyBible' && <StoryBiblePanel api={api} projectId={projectId} backendUrl={backendUrl} settings={settings} reloadSettings={reload} />}
      {view === 'cinematic' && <CinematicPanel api={api} projectId={projectId} settings={settings} reloadSettings={reload} />}
      {view === 'language' && <LanguagePanel api={api} projectId={projectId} backendUrl={backendUrl} />}
    </div>
  )
}
