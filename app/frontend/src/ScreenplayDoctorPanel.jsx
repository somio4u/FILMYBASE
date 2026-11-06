import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ScriptDoctorPanel.css'

// Screenplay Doctor: reviews the WHOLE film — structure, characters, world, market. Where each major beat falls is counted by the program (a share of the running time);
// the judging is the AI's. It runs in the background (the bar, "right now", how long, Stop) and still shows after a reload. Notes cite SCENE numbers (the app has no pages).
const EN = {
  title: '🎬 Screenplay Doctor', close: 'Close',
  intro: 'Reviews the whole film like a professional script doctor: does it work, what is strong and must be protected, what is broken and why, and what the next draft should be. Where each big moment falls is counted by the program; the judging is the AI\'s. Nothing in your screenplay is changed.',
  market: 'What is the film for?', start: 'Review the screenplay', again: 'Review again', starting: 'Starting…',
  working: (n, total, t) => `Step ${n} of ${total} — running for ${t}`, rightNow: 'Right now', stop: 'Stop', stopping: 'Stopping…', stopped: 'Stopped. Start again to finish the review.',
  failed: 'These parts could not be done:', error: 'Something went wrong. Please try again.', offline: 'The server did not answer. Check the internet and try again.',
  verdict: 'Verdict', verdicts: { 'Shoot-ready': 'Shoot-ready', Polish: 'Polish', Revise: 'Revise', Rewrite: 'Rewrite', Rethink: 'Rethink' }, overall: 'Overall score', biggest: 'The single biggest fix', logline: 'Logline as the doctor reads it', assumptions: 'Assumptions',
  structure: 'Structure map (share of the running time)', scoreTitle: 'Scorecard (1–10)', merits: 'Merits — protect these', issues: 'Problems by severity', orphans: 'Plants and payoffs that do not match', commercial: 'Indian commercial checklist', risks: 'Sensitivity and production flags', plan: 'Revision plan, biggest lever first', late: 'Characters who arrive late',
  send: '→ Send these findings to Script Doctor', sending: 'Sending…', sentLine: (n) => `Sent: ${n} changes are now in Script Doctor. Open “Script Doctor report” — press ▶ to make them in the scenes, or ⚡ for a new story.`, sceneWord: 'Scene', where: 'Scenes',
  verdictBeat: { 'on target': '✓ on target', early: '⚠ early', late: '⚠ late', 'not found': '✗ not found' },
}
const HI = {
  ...EN,
  intro: 'पूरी film को एक पेशेवर script doctor की तरह परखता है: चलती है या नहीं, क्या मज़बूत है और बचाना है, क्या टूटा है और क्यों, और अगला draft कैसा हो। बड़े पल कहाँ पड़ते हैं, यह program गिनता है; फ़ैसले AI के हैं। आपकी screenplay में कुछ नहीं बदलता।',
  market: 'यह film किसके लिए है?', start: 'Screenplay परखो', again: 'फिर से परखो', starting: 'शुरू हो रहा है…',
  working: (n, total, t) => `कदम ${n} / ${total} — ${t} से चल रहा है`, rightNow: 'अभी', stop: 'रोको', stopping: 'रुक रहा है…', stopped: 'रुक गया। परख पूरी करने के लिए फिर शुरू करो।',
  failed: 'ये हिस्से नहीं हो पाए:', error: 'कुछ गड़बड़ हुई। फिर कोशिश करो।', offline: 'server ने जवाब नहीं दिया। इंटरनेट देखकर फिर कोशिश करो।',
  verdict: 'फ़ैसला', overall: 'कुल score', biggest: 'सबसे बड़ा एक सुधार', logline: 'Doctor की समझ से logline', assumptions: 'मान्यताएँ',
  structure: 'ढाँचे का नक्शा (चलने के समय का हिस्सा)', scoreTitle: 'Scorecard (1–10)', merits: 'खूबियाँ — इन्हें बचाओ', issues: 'गंभीरता के हिसाब से समस्याएँ', orphans: 'जो plant और payoff मेल नहीं खाते', commercial: 'भारतीय commercial checklist', risks: 'संवेदनशीलता और production के निशान', plan: 'सुधार की योजना, सबसे बड़ा असर पहले', late: 'जो किरदार देर से आते हैं',
  send: '→ ये बातें Script Doctor को भेजो', sending: 'भेज रहा है…', sentLine: (n) => `भेज दिया: ${n} बदलाव अब Script Doctor में हैं। “Script Doctor report” खोलो — scenes में लगाने के लिए ▶, या नई कहानी के लिए ⚡ दबाओ।`, sceneWord: 'Scene', where: 'Scenes',
  verdictBeat: { 'on target': '✓ ठीक जगह', early: '⚠ जल्दी', late: '⚠ देर से', 'not found': '✗ नहीं मिला' },
}
const TEXT = { en: EN, hi: HI, or: EN }
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s` }
const call = async (url, method = 'GET', body) => {
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { ok: r.ok, data: await r.json().catch(() => ({})) }
  } catch { return { ok: false, data: {}, offline: true } }
}

export default function ScreenplayDoctorPanel({ backendUrl, projectId, language = 'en', onClose, onOpenScriptDoctor }) {
  const L = TEXT[language] ?? EN
  const api = `${backendUrl}/api/ai-movie/projects/${projectId}/screenplay-doctor`
  const [state, setState] = useState({ job: null, run: null, markets: [] })
  const [market, setMarket] = useState('indian_commercial')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [, setTick] = useState(0)
  const alive = useRef(true)
  const load = useCallback(async () => { const r = await call(api); if (alive.current && r.ok) setState(r.data) }, [api])
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false } }, [load])
  const running = state.job?.status === 'running'
  useEffect(() => { const t = setInterval(() => { setTick((n) => n + 1); if (running) load() }, 3000); return () => clearInterval(t) }, [running, load])

  async function start() {
    setBusy('start'); setError(''); setNote('')
    const r = await call(api, 'POST', { market })
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
  const o = run?.overview
  const done = o && !running
  const handled = job ? (job.done ?? 0) + (job.failed?.length ?? 0) : 0
  const late = run?.film?.late ?? []

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
          <label className="sd-fine">{L.market}{' '}
            <select value={market} onChange={(e) => setMarket(e.target.value)}>
              {(state.markets.length ? state.markets : [{ id: 'indian_commercial', label: 'Indian commercial' }]).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
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
            <h3>{L.verdict}: {L.verdicts[o.verdict] ?? o.verdict}{o.overall ? ` · ${L.overall}: ${o.overall}/10` : ''}</h3>
            <p>{o.verdictReason}</p>
            {o.biggestFix && <p><strong>{L.biggest}:</strong> {o.biggestFix}</p>}
            {o.logline && <p className="sd-fine"><strong>{L.logline}:</strong> {o.logline}</p>}
            {o.assumptions && <p className="sd-fine"><strong>{L.assumptions}:</strong> {o.assumptions}</p>}
            <p><button type="button" className="sd-btn primary" disabled={busy === 'send'} onClick={send}>{busy === 'send' ? L.sending : L.send}</button></p>
            {note && <p className="sd-ok" role="status">{note} <button type="button" className="sd-link" onClick={onOpenScriptDoctor}>Script Doctor →</button></p>}
          </section>
          <section className="sd-step">
            <h3>{L.structure}</h3>
            <ul className="sd-progress">{(o.positions ?? []).map((p) => <li key={p.key}><strong>{p.name}</strong> <small>· {p.scene ? `${L.sceneWord} ${p.scene} · ${p.pct}% (${p.range[0]}–${p.range[1]}%)` : ''} · {L.verdictBeat[p.verdict] ?? p.verdict}</small></li>)}</ul>
            {late.length > 0 && <p className="sd-fine"><strong>{L.late}:</strong> {late.map((l) => `${l.character} (${l.pct}%)`).join(' · ')}</p>}
          </section>
          <section className="sd-step">
            <h3>{L.scoreTitle}</h3>
            <ul className="sd-progress">{o.scores.map((s) => <li key={s.lens}><strong>{s.lens}: {s.score}/10</strong> <small>· {s.reason}</small></li>)}</ul>
          </section>
          {o.merits.length > 0 && <section className="sd-step"><h3>{L.merits}</h3><ul>{o.merits.map((m, i) => <li key={i}>{m}</li>)}</ul></section>}
          <section className="sd-step">
            <h3>{L.issues}</h3>
            <ul className="sd-progress">{o.issues.map((i, k) => (
              <li key={k} className={`sd-item is-${i.severity === 'Critical' ? 'critical' : i.severity === 'Major' ? 'major' : 'minor'}`}>
                <strong>{i.severity} · {i.lens}</strong>{i.scenes.length > 0 && <small> · {L.where} {i.scenes.join(', ')}</small>}
                <p className="sd-text">{i.problem}{i.fixes.map((f, n) => `\n${n + 1}. ${f}`).join('')}</p>
              </li>))}</ul>
          </section>
          {o.orphans.length > 0 && <section className="sd-step"><h3>{L.orphans}</h3><ul>{o.orphans.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
          {o.commercial.length > 0 && <section className="sd-step"><h3>{L.commercial}</h3><ul className="sd-progress">{o.commercial.map((c, i) => <li key={i}><strong>{c.item}</strong> <small>· {c.status}{c.note ? ` · ${c.note}` : ''}</small></li>)}</ul></section>}
          {o.risks.length > 0 && <section className="sd-step"><h3>{L.risks}</h3><ul>{o.risks.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
          {o.revisionPlan.length > 0 && <section className="sd-step"><h3>{L.plan}</h3><ol>{o.revisionPlan.map((x, i) => <li key={i}>{x}</li>)}</ol></section>}
        </>
      )}
    </div>
  )
  return createPortal(<div className="sd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>{body}</div>, document.body)
}
