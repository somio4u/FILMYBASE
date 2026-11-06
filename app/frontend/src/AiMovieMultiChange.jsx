import { useCallback, useEffect, useState } from 'react'

// AI Movie → ONE instruction for SEVERAL scenes ("scenes 3-20: cut the narration"). The AI changes them one by one in the background; this box shows
// what it is doing right now, how long it has been running, and still shows after a page reload. Each scene is changed with the same safe path as
// "Ask AI to change it", so every changed scene can be undone with that scene's Undo.
const TEXT = {
  en: {
    title: 'Change several scenes at once', scenes: 'Which scenes (for example 3-20, 25)', what: 'What should change in all of them?', start: 'Change these scenes',
    ask: (n) => `The AI will rewrite ${n} scene${n === 1 ? '' : 's'}, one by one, with this instruction. Your other scenes are not touched. It may take a while and uses the AI (writing has no money limit). Go ahead?`, yes: 'Yes, go', no: 'No',
    working: (n, total, t) => `Changing scene ${n} of ${total} — running for ${t}`, rightNow: 'Right now', stop: 'Stop', stopping: 'Stopping…', done: (c, f) => `✓ Finished: ${c} scene${c === 1 ? '' : 's'} handled${f ? `, ${f} could not be done` : ''}.`, stopped: 'Stopped. The scenes already changed stay changed.', failedTitle: 'These scenes could not be done:',
    error: 'Something went wrong. Please try again.', offline: 'The server did not answer. Check the internet and try again.',
  },
  hi: {
    title: 'कई scenes एक साथ बदलो', scenes: 'कौन-से scenes (जैसे 3-20, 25)', what: 'इन सबमें क्या बदलना है?', start: 'ये scenes बदलो',
    ask: (n) => `AI इस निर्देश से ${n} scene एक-एक करके दोबारा लिखेगा। बाकी scenes नहीं छुए जाएँगे। इसमें समय लग सकता है और AI इस्तेमाल होता है (लिखने पर पैसों की सीमा नहीं)। आगे बढ़ें?`, yes: 'हाँ, चलाओ', no: 'नहीं',
    working: (n, total, t) => `scene ${n} / ${total} बदल रहा है — ${t} से चल रहा है`, rightNow: 'अभी', stop: 'रोको', stopping: 'रुक रहा है…', done: (c, f) => `✓ पूरा हुआ: ${c} scene हो गए${f ? `, ${f} नहीं हो पाए` : ''}।`, stopped: 'रुक गया। जो scenes बदल चुके हैं वे बदले ही रहेंगे।', failedTitle: 'ये scenes नहीं हो पाए:',
    error: 'कुछ गड़बड़ हुई। फिर कोशिश करो।', offline: 'server ने जवाब नहीं दिया। इंटरनेट देखकर फिर कोशिश करो।',
  },
  or: {
    title: 'ଏକାସାଙ୍ଗରେ ଅନେକ ସିନ୍ ବଦଳାଅ', scenes: 'କେଉଁ ସିନ୍ (ଯେପରି 3-20, 25)', what: 'ସବୁଥିରେ କ’ଣ ବଦଳିବ?', start: 'ଏହି ସିନ୍ ବଦଳାଅ',
    ask: (n) => `AI ଏହି ନିର୍ଦ୍ଦେଶରେ ${n} ସିନ୍ ଗୋଟିଏ ଗୋଟିଏ କରି ପୁଣି ଲେଖିବ। ଅନ୍ୟ ସିନ୍ ଛୁଆଯିବ ନାହିଁ। ସମୟ ଲାଗିପାରେ। ଆଗକୁ ବଢ଼ିବା?`, yes: 'ହଁ, ଚଲାଅ', no: 'ନା',
    working: (n, total, t) => `ସିନ୍ ${n} / ${total} ବଦଳୁଛି — ${t} ଧରି ଚାଲିଛି`, rightNow: 'ଏବେ', stop: 'ବନ୍ଦ କର', stopping: 'ବନ୍ଦ ହେଉଛି…', done: (c, f) => `✓ ସରିଲା: ${c} ସିନ୍ ହେଲା${f ? `, ${f}ଟି ହେଲା ନାହିଁ` : ''}।`, stopped: 'ବନ୍ଦ ହେଲା। ବଦଳିସାରିଥିବା ସିନ୍ ବଦଳିଥିବ।', failedTitle: 'ଏହି ସିନ୍ ହେଲା ନାହିଁ:',
    error: 'କିଛି ଭୁଲ ହେଲା। ପୁଣି ଚେଷ୍ଟା କର।', offline: 'ସର୍ଭର ଉତ୍ତର ଦେଲା ନାହିଁ।',
  },
}
const call = async (url, method = 'GET', body) => {
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { ok: r.ok, data: await r.json().catch(() => ({})) }
  } catch { return { ok: false, offline: true, data: {} } }
}
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export default function AiMovieMultiChange({ backendUrl, projectId, draftId, language = 'en', disabled = false, onChanged }) {
  const L = TEXT[language === 'or' ? 'or' : language === 'hi' ? 'hi' : 'en']
  const [scenes, setScenes] = useState('')
  const [what, setWhat] = useState('')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(Date.now())
  const api = `${backendUrl}/api/ai-movie/projects/${projectId}/multi-change`
  const running = job?.status === 'running'
  const load = useCallback(async () => { const r = await call(`${api}/current`); if (r.ok) setJob(r.data.job ?? null) }, [api])
  useEffect(() => { load() }, [load])
  useEffect(() => { const t = setInterval(() => { setTick(Date.now()); if (running) load() }, 3000); return () => clearInterval(t) }, [running, load])
  const finishedSeen = job && job.status !== 'running'
  useEffect(() => { if (finishedSeen) onChanged?.() }, [finishedSeen, job?.jobId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setAsking(false); setBusy(true); setError('')
    const r = await call(api, 'POST', { draftId, scenes, instruction: what })
    setBusy(false)
    if (!r.ok) { setError(r.offline ? L.offline : (r.data.error || L.error)); return }
    setJob(r.data.job)
  }
  async function stop() { await call(`${api}/stop`, 'POST', {}); load() }

  const count = (() => { try { return scenes.split(/[,;\s]+/).filter(Boolean).reduce((n, p) => { const m = /^(\d+)(?:[-–—](\d+))?$/.exec(p); return m ? n + (Number(m[2] ?? m[1]) - Number(m[1]) + 1) : n }, 0) } catch { return 0 } })()
  const handled = job ? (job.done ?? 0) + (job.failed?.length ?? 0) : 0

  return (
    <div className="ai-scene-multi">
      <p className="script-panel-title">{L.title}</p>
      {running ? (
        <>
          <div className="sd-bar" role="progressbar" aria-valuenow={handled} aria-valuemax={job.total}><div style={{ width: `${Math.round((handled / Math.max(1, job.total)) * 100)}%` }} /></div>
          <p className="ai-movie-scene-duration">⏳ {L.working(Math.min(handled + 1, job.total), job.total, clock(tick - job.startedAt))}</p>
          <p className="ai-movie-scene-duration"><strong>{L.rightNow}:</strong> {job.step}</p>
          <button type="button" className="cancel-button" disabled={job.stopRequested} onClick={stop}>{job.stopRequested ? L.stopping : L.stop}</button>
        </>
      ) : (
        <>
          <label className="ai-scene-field">{L.scenes}<input type="text" value={scenes} maxLength={200} disabled={disabled || busy} onChange={(e) => setScenes(e.target.value)} placeholder="3-20, 25" /></label>
          <label className="ai-scene-field">{L.what}<textarea className="feedback-textarea" value={what} maxLength={2000} disabled={disabled || busy} onChange={(e) => setWhat(e.target.value)} /></label>
          {!asking ? (
            <button type="button" className="choose-button" disabled={disabled || busy || !draftId || count === 0 || what.trim().length < 4} onClick={() => setAsking(true)}>{L.start}</button>
          ) : (
            <div className="feedback-form" role="alertdialog">
              <p>{L.ask(count)}</p>
              <button type="button" className="choose-button" onClick={start}>{L.yes}</button>{' '}
              <button type="button" className="cancel-button" onClick={() => setAsking(false)}>{L.no}</button>
            </div>
          )}
          {finishedSeen && job.status === 'done' && <p className="ai-movie-scene-duration" role="status">{L.done(job.done ?? 0, job.failed?.length ?? 0)}</p>}
          {finishedSeen && job.status === 'stopped' && <p className="ai-movie-scene-duration" role="status">{L.stopped}</p>}
          {finishedSeen && (job.failed?.length ?? 0) > 0 && (
            <div className="feedback-note" role="alert">
              <p>{L.failedTitle}</p>
              <ul>{job.failed.slice(0, 6).map((f) => <li key={f.label}>{f.label}: {f.error}</li>)}</ul>
            </div>
          )}
          {finishedSeen && job.status === 'error' && <p className="feedback-note" role="alert">{job.error}</p>}
        </>
      )}
      {error && <p className="feedback-note" role="alert">{error}</p>}
    </div>
  )
}
