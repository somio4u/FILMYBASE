import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ScriptDoctorPanel.css'

// Dialogue Doctor: looks ONLY at what characters say, where they should say it and where they should stay quiet. The numbers are counted by the program;
// the judging is the AI's. It runs in the background (the bar, "right now", how long, Stop) and still shows after a reload.
const EN = {
  title: '🩺 Dialogue Doctor', close: 'Close',
  intro: 'Checks only the dialogue of this film: is it good, does it hit, is there too much or too little, where should there be silence, what is missing, and where light comedy fits. The counting is done by the program (exact); the judging by the AI. Nothing in your screenplay is changed.',
  genre: 'What kind of film is it?', start: 'Check the dialogue', again: 'Check again', starting: 'Starting…',
  working: (n, total, t) => `Step ${n} of ${total} — running for ${t}`, rightNow: 'Right now', stop: 'Stop', stopping: 'Stopping…', stopped: 'Stopped. Start again to finish the check.',
  failed: 'These parts could not be done:', error: 'Something went wrong. Please try again.', offline: 'The server did not answer. Check the internet and try again.',
  verdict: 'Verdict', verdicts: { Polish: 'Polish — line edits only', 'Dialogue pass': 'Dialogue pass — scene-level rewrites', Rebuild: 'Rebuild — voices and emotional groundwork need new scenes' }, top: 'The three biggest fixes',
  numbers: 'The numbers (counted exactly)', nScenes: (n) => `${n} scenes`, nShare: (n) => `dialogue is ${n}% of all words`, nNarr: (n) => `${n} narration line${n === 1 ? '' : 's'}`, nSilent: (n) => `${n} scene${n === 1 ? '' : 's'} with no dialogue`,
  speakers: 'Who speaks most', lines: 'lines', scores: 'Scorecard (1–10)', beats: 'Must-have dialogue beats', flags: 'Scene by scene', onlyFix: 'Only scenes that need a change', allScenes: 'All scenes', more: 'Show more',
  peaks: 'Emotional peaks', comedy: 'Where light comedy fits', voices: 'Voices', alike: 'sounds like someone else', best: 'Lines to protect', gaps: 'Relationship pairs with almost no real exchanges',
  send: '→ Send these findings to Script Doctor', sending: 'Sending…', sentLine: (n) => `Sent: ${n} changes are now in Script Doctor. Open “Script Doctor report” — press ▶ to make them in the scenes, or ⚡ for a new story.`, sceneWord: 'Scene',
  fl: { KEEP: 'KEEP', TRIM: 'TRIM', EXPAND: 'EXPAND', CUT_TO_SILENCE: 'CUT → SILENCE', ADD_DIALOGUE: 'ADD DIALOGUE', ADD_EMOTION: 'ADD EMOTION', ADD_LIGHT_COMEDY: 'ADD LIGHT COMEDY', REWRITE_VOICE: 'REWRITE VOICE', ON_THE_NOSE: 'ON-THE-NOSE' },
}
const HI = {
  ...EN,
  intro: 'सिर्फ़ इस film के dialogue को जाँचता है: अच्छा है या नहीं, असर करता है या नहीं, ज़्यादा है या कम, कहाँ चुप्पी चाहिए, क्या छूटा है और हल्की comedy कहाँ बैठेगी। गिनती program करता है (बिल्कुल सही); फ़ैसले AI के हैं। आपकी screenplay में कुछ नहीं बदलता।',
  genre: 'यह किस तरह की film है?', start: 'Dialogue जाँचो', again: 'फिर से जाँचो', starting: 'शुरू हो रहा है…',
  working: (n, total, t) => `कदम ${n} / ${total} — ${t} से चल रहा है`, rightNow: 'अभी', stop: 'रोको', stopping: 'रुक रहा है…', stopped: 'रुक गया। जाँच पूरी करने के लिए फिर शुरू करो।',
  failed: 'ये हिस्से नहीं हो पाए:', error: 'कुछ गड़बड़ हुई। फिर कोशिश करो।', offline: 'server ने जवाब नहीं दिया। इंटरनेट देखकर फिर कोशिश करो।',
  verdict: 'फ़ैसला', verdicts: { Polish: 'Polish — सिर्फ़ लाइनें सुधारनी हैं', 'Dialogue pass': 'Dialogue pass — scene-स्तर पर दोबारा लिखना', Rebuild: 'Rebuild — आवाज़ें और भावनात्मक नींव के लिए नए scenes चाहिए' }, top: 'तीन सबसे बड़े सुधार',
  numbers: 'गिनती (बिल्कुल सही)', nScenes: (n) => `${n} scenes`, nShare: (n) => `कुल शब्दों में dialogue ${n}%`, nNarr: (n) => `${n} narration लाइन`, nSilent: (n) => `${n} scene बिना dialogue के`,
  speakers: 'सबसे ज़्यादा कौन बोलता है', lines: 'लाइनें', scores: 'Scorecard (1–10)', beats: 'ज़रूरी dialogue beats', flags: 'Scene-दर-scene', onlyFix: 'सिर्फ़ वे scenes जिनमें बदलाव चाहिए', allScenes: 'सारे scenes', more: 'और दिखाओ',
  peaks: 'भावनात्मक चरम', comedy: 'हल्की comedy कहाँ बैठेगी', voices: 'आवाज़ें', alike: 'किसी और जैसा लगता है', best: 'बचाकर रखने वाली लाइनें', gaps: 'ऐसे रिश्ते जिनमें असली बातचीत लगभग नहीं है',
  send: '→ ये बातें Script Doctor को भेजो', sending: 'भेज रहा है…', sentLine: (n) => `भेज दिया: ${n} बदलाव अब Script Doctor में हैं। “Script Doctor report” खोलो — scenes में लगाने के लिए ▶, या नई कहानी के लिए ⚡ दबाओ।`, sceneWord: 'Scene',
}
const TEXT = { en: EN, hi: HI, or: EN }
const ICON = { Present: '✓', Weak: '⚠', Missing: '✗' }
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s` }
const call = async (url, method = 'GET', body) => {
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { ok: r.ok, data: await r.json().catch(() => ({})) }
  } catch { return { ok: false, data: {}, offline: true } }
}

export default function DialogueDoctorPanel({ backendUrl, projectId, language = 'en', onClose, onOpenScriptDoctor }) {
  const L = TEXT[language] ?? EN
  const api = `${backendUrl}/api/ai-movie/projects/${projectId}/dialogue-doctor`
  const [state, setState] = useState({ job: null, run: null, genres: [] })
  const [genre, setGenre] = useState('drama')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [onlyFix, setOnlyFix] = useState(true)
  const [shown, setShown] = useState(30)
  const [, setTick] = useState(0)
  const alive = useRef(true)
  const load = useCallback(async () => { const r = await call(api); if (alive.current && r.ok) setState(r.data) }, [api])
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false } }, [load])
  const running = state.job?.status === 'running'
  useEffect(() => { const t = setInterval(() => { setTick((n) => n + 1); if (running) load() }, 3000); return () => clearInterval(t) }, [running, load])

  async function start() {
    setBusy('start'); setError(''); setNote('')
    const r = await call(api, 'POST', { genre })
    setBusy('')
    if (!r.ok) { setError(r.offline ? L.offline : (r.data.error || L.error)); return }
    setState(r.data)
  }
  async function stop() { await call(`${api}/stop`, 'POST', {}); load() }
  async function send() {
    setBusy('send'); setError('')
    const r = await call(`${api}/${state.run.id}/send`, 'POST', {})
    setBusy('')
    if (!r.ok) { setError(r.offline ? L.offline : (r.data.error || L.error)); return }
    setNote(L.sentLine(r.data.items)); load()
  }

  const { job, run } = state
  const done = run?.overview && !running
  const handled = job ? (job.done ?? 0) + (job.failed?.length ?? 0) : 0
  const notes = (run?.notes ?? []).filter((n) => !onlyFix || n.flag !== 'KEEP')
  const peaks = (run?.notes ?? []).filter((n) => n.peak?.is)
  const best = (run?.notes ?? []).filter((n) => n.bestLine)
  const chars = Object.entries(run?.film?.characters ?? {}).slice(0, 8)

  const body = (
    <div className="sd-panel" role="dialog" aria-label={L.title}>
      <div className="sd-head"><h2>{L.title}</h2><button type="button" className="sd-x" onClick={onClose} aria-label={L.close}>×</button></div>
      <p className="sd-fine">{L.intro}</p>
      {running ? (
        <section className="sd-step">
          <div className="sd-bar" role="progressbar" aria-valuenow={handled} aria-valuemax={job.total}><div style={{ width: `${Math.round((handled / Math.max(1, job.total)) * 100)}%` }} /></div>
          <p className="sd-live">⏳ {L.working(Math.min(handled + 1, job.total), job.total, clock(Date.now() - job.startedAt))}</p>
          <p className="sd-fine"><strong>{L.rightNow}:</strong> {job.step}</p>
          <button type="button" className="sd-btn" disabled={job.stopRequested} onClick={stop}>{job.stopRequested ? L.stopping : L.stop}</button>
        </section>
      ) : (
        <section className="sd-step">
          <label className="sd-fine">{L.genre}{' '}
            <select value={genre} onChange={(e) => setGenre(e.target.value)}>
              {(state.genres.length ? state.genres : [{ id: 'drama', label: 'Drama / family', min: 55, max: 70 }]).map((g) => <option key={g.id} value={g.id}>{g.label} ({g.min}–{g.max}%)</option>)}
            </select>
          </label>
          <p><button type="button" className="sd-btn primary big" disabled={Boolean(busy)} onClick={start}>{busy === 'start' ? L.starting : (run ? L.again : L.start)}</button></p>
          {job?.status === 'stopped' && <p className="sd-fine">{L.stopped}</p>}
          {job?.status === 'error' && <p className="sd-error" role="alert">{job.error}</p>}
          {(job?.failed?.length ?? 0) > 0 && job.status !== 'running' && <div className="sd-error" role="alert"><p>{L.failed}</p><ul>{job.failed.slice(0, 5).map((f) => <li key={f.label}>{f.label}: {f.error}</li>)}</ul></div>}
        </section>
      )}
      {error && <p className="sd-error" role="alert">{error}</p>}

      {done && (
        <>
          <section className="sd-step">
            <h3>{L.verdict}: {L.verdicts[run.overview.verdict] ?? run.overview.verdict}</h3>
            <p>{run.overview.verdictReason}</p>
            {run.overview.topFixes.length > 0 && <><h4>{L.top}</h4><ol>{run.overview.topFixes.map((f, i) => <li key={i}>{f}</li>)}</ol></>}
            <p><button type="button" className="sd-btn primary" disabled={busy === 'send'} onClick={send}>{busy === 'send' ? L.sending : L.send}</button></p>
            {note && <p className="sd-ok" role="status">{note} <button type="button" className="sd-link" onClick={onOpenScriptDoctor}>Script Doctor →</button></p>}
          </section>
          <section className="sd-step">
            <h3>{L.numbers}</h3>
            <p className="sd-fine">{[L.nScenes(run.film.scenes), L.nShare(run.film.dialoguePct), L.nNarr(run.film.narrationLines), L.nSilent(run.film.silentScenes.length)].join(' · ')}</p>
            <p className="sd-fine"><strong>{L.speakers}:</strong> {chars.map(([c, e]) => `${c} ${e.lines} ${L.lines}`).join(' · ')}</p>
          </section>
          <section className="sd-step">
            <h3>{L.scores}</h3>
            <ul className="sd-progress">{run.overview.scores.map((s) => <li key={s.area}><strong>{s.area}: {s.score}/10</strong> <small>· {s.reason}</small></li>)}</ul>
          </section>
          <section className="sd-step">
            <h3>{L.beats}</h3>
            <ul className="sd-progress">{run.overview.mustHave.map((m, i) => <li key={i}><span className="sd-mark">{ICON[m.status]}</span> <strong>{m.beat}</strong> <small>· {m.status}{m.scene ? ` · ${L.sceneWord} ${m.scene}` : ''}{m.note ? ` · ${m.note}` : ''}</small></li>)}</ul>
          </section>
          <section className="sd-step">
            <h3>{L.flags}</h3>
            <p><button type="button" className="sd-btn" onClick={() => { setOnlyFix(!onlyFix); setShown(30) }}>{onlyFix ? L.allScenes : L.onlyFix}</button></p>
            <ul className="sd-progress">{notes.slice(0, shown).map((n) => (
              <li key={n.number} className={`sd-item ${n.flag === 'KEEP' ? '' : 'is-major'}`}><strong>{L.sceneWord} {n.number} · {L.fl[n.flag]}</strong><p className="sd-text">{n.problem}{n.fix ? `\n→ ${n.fix}` : ''}</p></li>
            ))}</ul>
            {notes.length > shown && <button type="button" className="sd-btn" onClick={() => setShown(shown + 30)}>{L.more} ({notes.length - shown})</button>}
          </section>
          {peaks.length > 0 && <section className="sd-step"><h3>{L.peaks}</h3><ul className="sd-progress">{peaks.map((n) => <li key={n.number}><strong>{L.sceneWord} {n.number}: {n.peak.verdict}</strong> <small>· {n.peak.reason}</small></li>)}</ul></section>}
          {(run.overview.comedyMap.length > 0 || run.notes.some((n) => n.comedy?.add)) && <section className="sd-step"><h3>{L.comedy}</h3><ul className="sd-progress">{[...run.overview.comedyMap.map((c) => ({ scene: c.scene, idea: c.idea })), ...run.notes.filter((n) => n.comedy?.add).map((n) => ({ scene: n.number, idea: n.comedy.idea }))].slice(0, 12).map((c, i) => <li key={i}><strong>{c.scene ? `${L.sceneWord} ${c.scene}` : '—'}</strong> <small>· {c.idea}</small></li>)}</ul></section>}
          {run.overview.voices.length > 0 && <section className="sd-step"><h3>{L.voices}</h3><ul className="sd-progress">{run.overview.voices.map((v) => <li key={v.character}><strong>{v.character}</strong>{!v.distinct && <small> · ⚠ {L.alike}</small>}<p className="sd-text">{v.voice}</p></li>)}</ul></section>}
          {run.overview.pairGaps.length > 0 && <section className="sd-step"><h3>{L.gaps}</h3><ul>{run.overview.pairGaps.map((p, i) => <li key={i}>{p}</li>)}</ul></section>}
          {best.length > 0 && <section className="sd-step"><h3>{L.best}</h3><ul className="sd-progress">{best.slice(0, 10).map((n) => <li key={n.number}><strong>{L.sceneWord} {n.number}</strong> <small>· {n.bestLine.character}</small><p className="sd-text">{n.bestLine.line}</p></li>)}</ul></section>}
        </>
      )}
    </div>
  )
  return createPortal(<div className="sd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>{body}</div>, document.body)
}
