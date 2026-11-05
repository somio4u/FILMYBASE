import { useCallback, useEffect, useRef, useState } from 'react'
import './SmartScheduler.css'

// AI Movie → Screenplay → "Write the whole screenplay": ONE button instead of writing beat by beat, approving each one by hand and asking for the dialogue of every
// scene separately. The work runs on the server (every unfinished beat: its scenes, an automatic approval, the dialogue of every scene); this card only FOLLOWS it —
// which beat is being written now, how many are done, how long it has run — and it picks the job up again after a reload or a server restart.
const WORDS = {
  en: {
    title: '✍ Write the whole screenplay',
    intro: 'One press writes every beat that is not finished yet — its scenes, an automatic approval, and the dialogue of every scene — one beat after the other. Beats that are already approved with their dialogue are left as they are. You can read and change anything afterwards.',
    dialogueToo: 'Write the dialogue of every scene too',
    start: '✍ Write the whole screenplay',
    ask: 'Write every unfinished beat now? It reads your story and writes the scenes and dialogue with AI — it can take a long time for a long film and uses AI credit (your money limit is respected). You can leave this page; the work goes on on the server.',
    yes: 'Yes, write it',
    no: 'Cancel',
    starting: 'Starting…',
    running: (step, done, total, time) => <>⏳ {step} · <b>{done}</b> of {total} beats done · running for <b>{time}</b>. You can leave this page open, or come back later.</>,
    stop: 'Stop after this beat',
    stopping: 'Stopping after this beat…',
    done: (n, time) => `✓ Finished in ${time}: ${n} beat${n === 1 ? '' : 's'} written. Read them one by one with the arrows below; the beats written this way say “approved automatically”.`,
    stopped: 'Stopped. Press the button to carry on with the rest.',
    failed: (n) => `${n} beat${n === 1 ? '' : 's'} could not be finished:`,
    retry: 'Press the button again to try those once more.',
    offline: 'Could not reach the server — it may be waking up or restarting. Wait a minute and press the button again.',
    wrong: 'Something went wrong. Please try again.',
    other: 'Prefer to review each beat as it comes? Use the beat-by-beat button below instead.',
    beat: 'Beat',
  },
  hi: {
    title: '✍ पूरी screenplay लिखो',
    intro: 'एक बार दबाने पर हर अधूरा beat क्रम से लिखा जाता है — उसके scenes, अपने आप approve, और हर scene का dialogue। जो beats पहले से approve हैं और जिनका dialogue हो चुका है, उन्हें जैसा है वैसा छोड़ दिया जाता है। बाद में आप सब पढ़कर बदल सकते हो।',
    dialogueToo: 'हर scene का dialogue भी लिखो',
    start: '✍ पूरी screenplay लिखो',
    ask: 'अभी हर अधूरा beat लिखें? यह आपकी कहानी पढ़कर AI से scenes और dialogue लिखता है — लंबी film में बहुत देर लग सकती है और AI credit लगता है (आपकी पैसे की सीमा का ध्यान रखा जाता है)। आप यह page छोड़ सकते हो; काम server पर चलता रहता है।',
    yes: 'हाँ, लिखो',
    no: 'रद्द करो',
    starting: 'शुरू हो रहा है…',
    running: (step, done, total, time) => <>⏳ {step} · {total} में से <b>{done}</b> beats हुए · <b>{time}</b> से चल रहा है। आप यह page खुला रख सकते हो, या बाद में लौट सकते हो।</>,
    stop: 'इस beat के बाद रोको',
    stopping: 'इस beat के बाद रुक रहा है…',
    done: (n, time) => `✓ ${time} में पूरा हुआ: ${n} beats लिखे गए। नीचे तीरों से एक-एक करके पढ़ो; इस तरह लिखे beats पर “अपने आप approve” लिखा होगा।`,
    stopped: 'रुक गया। बाकी जारी रखने के लिए बटन दबाओ।',
    failed: (n) => `${n} beats पूरे नहीं हो सके:`,
    retry: 'उन्हें एक बार और आज़माने के लिए बटन फिर से दबाओ।',
    offline: 'Server तक पहुँच नहीं हुई — वह जाग रहा होगा या फिर चालू हो रहा होगा। एक मिनट रुककर बटन फिर दबाओ।',
    wrong: 'कुछ गड़बड़ हुई। कृपया फिर कोशिश करो।',
    other: 'हर beat आने पर खुद देखना चाहते हो? तो नीचे वाला beat-by-beat बटन इस्तेमाल करो।',
    beat: 'Beat',
  },
  or: {
    title: '✍ ପୁରା ସ୍କ୍ରିନପ୍ଲେ ଲେଖ',
    intro: 'ଥରେ ଦବାଇଲେ ପ୍ରତ୍ୟେକ ଅଧୁରା ବିଟ୍ କ୍ରମରେ ଲେଖାଯାଏ — ତାର ଦୃଶ୍ୟ, ନିଜେ ନିଜେ ଅନୁମୋଦନ, ଏବଂ ପ୍ରତ୍ୟେକ ଦୃଶ୍ୟର ସଂଳାପ। ଯେଉଁ ବିଟ୍ ଆଗରୁ ଅନୁମୋଦିତ ଓ ସଂଳାପ ସହିତ ଅଛି, ସେଗୁଡ଼ିକ ଯେମିତି ଅଛି ସେମିତି ରହେ। ପରେ ଆପଣ ସବୁ ପଢ଼ି ବଦଳାଇପାରିବେ।',
    dialogueToo: 'ପ୍ରତ୍ୟେକ ଦୃଶ୍ୟର ସଂଳାପ ମଧ୍ୟ ଲେଖ',
    start: '✍ ପୁରା ସ୍କ୍ରିନପ୍ଲେ ଲେଖ',
    ask: 'ବର୍ତ୍ତମାନ ପ୍ରତ୍ୟେକ ଅଧୁରା ବିଟ୍ ଲେଖିବା? ଏହା ଆପଣଙ୍କ କାହାଣୀ ପଢ଼ି AI ଦ୍ୱାରା ଦୃଶ୍ୟ ଓ ସଂଳାପ ଲେଖେ — ଲମ୍ବା ଫିଲ୍ମରେ ବହୁତ ସମୟ ଲାଗିପାରେ ଓ AI କ୍ରେଡିଟ୍ ଲାଗେ (ଆପଣଙ୍କ ଟଙ୍କା ସୀମା ମାନାଯାଏ)। ଆପଣ ଏହି ପୃଷ୍ଠା ଛାଡ଼ିପାରିବେ; କାମ ସର୍ଭରରେ ଚାଲିଥାଏ।',
    yes: 'ହଁ, ଲେଖ',
    no: 'ବାତିଲ୍',
    starting: 'ଆରମ୍ଭ ହେଉଛି…',
    running: (step, done, total, time) => <>⏳ {step} · {total} ମଧ୍ୟରୁ <b>{done}</b> ବିଟ୍ ହେଲା · <b>{time}</b> ଚାଲିଛି। ଆପଣ ଏହି ପୃଷ୍ଠା ଖୋଲା ରଖିପାରିବେ, କିମ୍ବା ପରେ ଫେରିପାରିବେ।</>,
    stop: 'ଏହି ବିଟ୍ ପରେ ଅଟକାଅ',
    stopping: 'ଏହି ବିଟ୍ ପରେ ଅଟକୁଛି…',
    done: (n, time) => `✓ ${time} ରେ ସରିଲା: ${n} ଟି ବିଟ୍ ଲେଖାଗଲା। ତଳେ ତୀର ଦ୍ୱାରା ଗୋଟି ଗୋଟି କରି ପଢ଼ନ୍ତୁ; ଏମିତି ଲେଖାଯାଇଥିବା ବିଟ୍ ଉପରେ “ନିଜେ ନିଜେ ଅନୁମୋଦିତ” ଲେଖା ଥିବ।`,
    stopped: 'ଅଟକିଲା। ବାକି ଜାରି ରଖିବାକୁ ବଟନ୍ ଦବାନ୍ତୁ।',
    failed: (n) => `${n} ଟି ବିଟ୍ ସରିପାରିଲା ନାହିଁ:`,
    retry: 'ସେଗୁଡ଼ିକୁ ଆଉ ଥରେ ଚେଷ୍ଟା କରିବାକୁ ବଟନ୍ ପୁଣି ଦବାନ୍ତୁ।',
    offline: 'ସର୍ଭରକୁ ପହଞ୍ଚିହେଲା ନାହିଁ — ସେ ଉଠୁଥିବ କିମ୍ବା ପୁନଃ ଚାଲୁ ହେଉଥିବ। ଏକ ମିନିଟ୍ ଅପେକ୍ଷା କରି ବଟନ୍ ପୁଣି ଦବାନ୍ତୁ।',
    wrong: 'କିଛି ଭୁଲ ହେଲା। ଦୟାକରି ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।',
    other: 'ପ୍ରତ୍ୟେକ ବିଟ୍ ଆସିଲେ ନିଜେ ଦେଖିବାକୁ ଚାହାଁନ୍ତି? ତେବେ ତଳର ବିଟ୍-ବାଇ-ବିଟ୍ ବଟନ୍ ବ୍ୟବହାର କରନ୍ତୁ।',
    beat: 'ବିଟ୍',
  },
}

const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }

export default function AiMovieWriteAll({ backendUrl, projectId, language = 'en', onChanged }) {
  const W = WORDS[language === 'or' ? 'or' : language === 'hi' ? 'hi' : 'en']
  const [job, setJob] = useState(null)
  const [dialogue, setDialogue] = useState(true)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const offset = useRef(0) // server clock minus this device's clock
  const alive = useRef(true)
  const lastSeen = useRef('') // what the screenplay screen was last refreshed for
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${backendUrl}/api/ai-movie/projects/${projectId}/write-all/current`)
      const body = await response.json().catch(() => ({}))
      if (!alive.current || !response.ok) return null
      if (body.now) offset.current = body.now - Date.now()
      setJob(body.jobId ? body : null)
      // the beats on the screen below follow the job: refresh them whenever one more beat is done or the job ends
      const mark = body.jobId ? `${body.jobId}:${body.done}:${body.failed?.length}:${body.status}` : ''
      if (mark && mark !== lastSeen.current) { lastSeen.current = mark; changedRef.current?.(projectId) }
      return body
    } catch {
      return null // the server may be restarting: the next look tries again
    }
  }, [backendUrl, projectId])

  useEffect(() => {
    alive.current = true
    lastSeen.current = ''
    load()
    return () => { alive.current = false }
  }, [load])

  const running = job?.status === 'running'
  useEffect(() => {
    if (!running) return undefined
    const look = setInterval(load, 3000)
    const clockTick = setInterval(() => setTick((t) => t + 1), 1000)
    return () => { clearInterval(look); clearInterval(clockTick) }
  }, [running, load])

  async function start() {
    setAsking(false); setBusy(true); setError('')
    try {
      const response = await fetch(`${backendUrl}/api/ai-movie/projects/${projectId}/write-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dialogue }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) setError(body.error || W.wrong)
      await load()
    } catch {
      setError(W.offline)
    }
    setBusy(false)
  }

  async function stop() {
    if (!job?.jobId) return
    try { await fetch(`${backendUrl}/api/ai-movie/projects/${projectId}/write-all/${job.jobId}/stop`, { method: 'POST' }) } catch { /* the next look shows what happened */ }
    load()
  }

  const finished = job && !running
  const elapsed = job?.startedAt ? (running ? Date.now() + offset.current : (job.finishedAt ?? Date.now() + offset.current)) - job.startedAt : 0
  void tick
  const handled = job ? job.done + (job.failed?.length ?? 0) : 0
  const percent = job?.total ? Math.round((handled / job.total) * 100) : 0

  return (
    <div className="ss-card sync-card ai-movie-write-all">
      <h3>{W.title}</h3>
      {!running && <p className="ss-sub">{W.intro}</p>}

      {running && (
        <>
          <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,.25)', overflow: 'hidden', margin: '8px 0' }}>
            <div style={{ width: `${percent}%`, height: '100%', background: '#2e9e5b', transition: 'width .4s' }} />
          </div>
          <p className="sync-live">{W.running(job.step, handled, job.total, clock(elapsed))}</p>
          {job.notice && <p className="ss-note" role="status">🔁 {job.notice}</p>}
          <button type="button" className="ss-back" onClick={stop} disabled={job.stopRequested}>{job.stopRequested ? W.stopping : W.stop}</button>
        </>
      )}

      {!running && !asking && (
        <>
          <label className="ss-note" style={{ display: 'block', margin: '6px 0' }}>
            <input type="checkbox" checked={dialogue} onChange={(e) => setDialogue(e.target.checked)} /> {W.dialogueToo}
          </label>
          <button type="button" className="ss-go" onClick={() => setAsking(true)} disabled={busy}>{busy ? W.starting : W.start}</button>
        </>
      )}
      {asking && (
        <div className="sync-ask" role="alertdialog">
          <p>{W.ask}</p>
          <button type="button" className="ss-go" onClick={start}>{W.yes}</button>{' '}
          <button type="button" className="ss-back" onClick={() => setAsking(false)}>{W.no}</button>
        </div>
      )}

      {finished && job.status === 'done' && job.failed?.length === 0 && <p className="ss-note">{W.done(job.done, clock(elapsed))}</p>}
      {finished && job.status === 'stopped' && <p className="ss-note">{W.stopped}</p>}
      {finished && job.failed?.length > 0 && (
        <div className="ss-error" role="alert">
          <p>{W.failed(job.failed.length)}</p>
          <ul>{job.failed.slice(0, 6).map((f) => <li key={f.sceneIndex}>{/^Beat \d+/.test(f.error ?? '') ? f.error : `${W.beat} ${f.sceneIndex + 1}: ${f.error}`}</li>)}</ul>
          <p>{W.retry}</p>
        </div>
      )}
      {finished && job.status === 'error' && job.error && <p className="ss-error" role="alert">{job.error}</p>}
      {error && <p className="ss-error" role="alert">{error}</p>}
      {!running && <p className="ss-note">{W.other}</p>}
    </div>
  )
}
