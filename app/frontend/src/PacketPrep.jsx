import { useCallback, useEffect, useRef, useState } from 'react'
import './SmartScheduler.css'

// Production Management → "Artist scripts, ready to send": every character's script packet (details, arc, emotional graph) is prepared BEFORE it is needed,
// in English, Odia and Hindi. The work runs on the server (after Synchronize it starts by itself); this card only FOLLOWS it: what is being made right now,
// how many are done, how long it has run — and it picks the job up again after a reload.
const WORDS = {
  en: {
    title: '📨 Artist scripts — ready to send',
    sub: <>Each artist's script holds the character's details, how the character changes (the arc), how the feeling rises and falls (the emotional graph) and every scene they are in, in full — written in Odia. Preparing them now means sending a link or opening a PDF is instant: nobody waits for the AI at that moment. After <b>Synchronize</b> this starts by itself.</>,
    also: 'Also prepare in',
    names: { en: 'English', hi: 'Hindi' },
    running: (step, done, total, time) => <>⏳ {step} · <b>{done}</b> of {total} done · running for <b>{time}</b>. You can leave this page open, or come back later — the work goes on on the server.</>,
    stop: 'Stop after this one',
    allReady: (characters, ready) => `✓ All ${characters} characters' scripts are ready (${ready}). Sending and opening is instant.`,
    someReady: (ready, total, left) => `${ready} of ${total} scripts are ready. ${left} still to prepare.`,
    prepareAll: '📨 Prepare all artist scripts',
    prepareLeft: (left) => `📨 Prepare the missing ${left}`,
    starting: 'Starting…',
    finished: (time) => `Finished in ${time}.`,
    failed: (n, why) => `${n} could not be prepared this time (${why || 'the AI did not answer'}). Press the button to try those again; their scenes can still be sent in full meanwhile.`,
    stopped: 'Stopped. Press the button to carry on with the rest.',
    cannotCheck: 'Could not check the artist scripts.',
    wrong: 'Something went wrong. Please try again.',
    offline: 'Could not reach the server — it may be waking up or restarting. Wait a minute and press the button again.',
  },
  or: {
    title: '📨 କଳାକାରଙ୍କ ସ୍କ୍ରିପ୍ଟ — ପଠାଇବାକୁ ପ୍ରସ୍ତୁତ',
    sub: <>ପ୍ରତ୍ୟେକ କଳାକାରଙ୍କ ସ୍କ୍ରିପ୍ଟରେ ଚରିତ୍ରର ବିବରଣୀ, ଚରିତ୍ର କେମିତି ବଦଳେ (ଆର୍କ), ଭାବନା କେମିତି ଉଠେ-ପଡ଼େ (ଭାବନାର ଗ୍ରାଫ୍) ଏବଂ ସେ ଥିବା ପ୍ରତ୍ୟେକ ଦୃଶ୍ୟ ପୂରା ଥାଏ — ସବୁ ଓଡ଼ିଆରେ। ଏସବୁ ଆଗରୁ ତିଆରି ରଖିଲେ ଲିଙ୍କ ପଠାଇବା କିମ୍ବା PDF ଖୋଲିବା ବେଳେ କାହାକୁ AI ପାଇଁ ଅପେକ୍ଷା କରିବାକୁ ପଡ଼ିବ ନାହିଁ। <b>Synchronize</b> ପରେ ଏହା ନିଜେ ଆରମ୍ଭ ହୁଏ।</>,
    also: 'ଏହା ସହିତ ଏଥିରେ ମଧ୍ୟ ତିଆରି କର',
    names: { en: 'ଇଂରାଜୀ', hi: 'ହିନ୍ଦୀ' },
    running: (step, done, total, time) => <>⏳ {step} · {total} ମଧ୍ୟରୁ <b>{done}</b> ହେଲା · <b>{time}</b> ଚାଲିଛି। ଏହି ପୃଷ୍ଠା ଖୋଲା ରଖିପାରିବ, କିମ୍ବା ପରେ ଫେରିପାରିବ — କାମ ସର୍ଭରରେ ଚାଲିଥିବ।</>,
    stop: 'ଏହା ପରେ ଅଟକାଅ',
    allReady: (characters, ready) => `✓ ସମସ୍ତ ${characters} ଚରିତ୍ରର ସ୍କ୍ରିପ୍ଟ ପ୍ରସ୍ତୁତ (${ready})। ପଠାଇବା ଓ ଖୋଲିବା ତତକ୍ଷଣାତ୍।`,
    someReady: (ready, total, left) => `${total} ମଧ୍ୟରୁ ${ready} ସ୍କ୍ରିପ୍ଟ ପ୍ରସ୍ତୁତ। ${left} ବାକି।`,
    prepareAll: '📨 ସବୁ କଳାକାରଙ୍କ ସ୍କ୍ରିପ୍ଟ ପ୍ରସ୍ତୁତ କର',
    prepareLeft: (left) => `📨 ବାକି ${left} ପ୍ରସ୍ତୁତ କର`,
    starting: 'ଆରମ୍ଭ ହେଉଛି…',
    finished: (time) => `${time} ରେ ସରିଲା।`,
    failed: (n, why) => `${n} ଟି ଏଥର ପ୍ରସ୍ତୁତ ହୋଇପାରିଲା ନାହିଁ (${why || 'AI ଉତ୍ତର ଦେଲା ନାହିଁ'})। ସେଗୁଡ଼ିକୁ ପୁଣି ଚେଷ୍ଟା କରିବାକୁ ବଟନ୍ ଦବାଅ; ସେ ଯାଏ ସେମାନଙ୍କ ଦୃଶ୍ୟ ପୂରା ପଠାଯାଇପାରିବ।`,
    stopped: 'ଅଟକିଲା। ବାକିଗୁଡ଼ିକ ଜାରି ରଖିବାକୁ ବଟନ୍ ଦବାଅ।',
    cannotCheck: 'କଳାକାରଙ୍କ ସ୍କ୍ରିପ୍ଟ ଯାଞ୍ଚ କରିହେଲା ନାହିଁ।',
    wrong: 'କିଛି ଭୁଲ ହେଲା। ଦୟାକରି ପୁଣି ଚେଷ୍ଟା କର।',
    offline: 'ସର୍ଭରକୁ ପହଞ୍ଚିହେଲା ନାହିଁ — ସେ ଉଠୁଥିବ କିମ୍ବା ପୁନଃ ଚାଲୁ ହେଉଥିବ। ଏକ ମିନିଟ୍ ଅପେକ୍ଷା କରି ବଟନ୍ ପୁଣି ଦବାଅ।',
  },
}

const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }

export default function PacketPrep({ backendUrl, sceneListId, language = 'en' }) {
  const W = WORDS[language === 'or' ? 'or' : 'en']
  const [extra, setExtra] = useState({ en: false, hi: false }) // Odia is always prepared; English / Hindi only when asked
  const languages = ['or', ...['en', 'hi'].filter((l) => extra[l])]
  const [info, setInfo] = useState(null) // { job, ready, total, characters }
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const offset = useRef(0) // server clock minus this device's clock
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/packet-jobs/current?languages=${languages.join(',')}`)
      const body = await response.json().catch(() => ({}))
      if (!alive.current) return null
      if (!response.ok) { setError(body.error || W.cannotCheck); return null }
      if (body.job?.now) offset.current = body.job.now - Date.now()
      setError('')
      setInfo(body)
      return body
    } catch {
      return null // the server may be restarting: the next look tries again
    }
  }, [backendUrl, sceneListId, languages.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    alive.current = true
    load()
    return () => { alive.current = false }
  }, [load])

  const running = info?.job?.status === 'running'
  // while it runs: look at the server every 3 seconds and tick the clock every second
  useEffect(() => {
    if (!running) return undefined
    const look = setInterval(load, 3000)
    const clockTick = setInterval(() => setTick((t) => t + 1), 1000)
    return () => { clearInterval(look); clearInterval(clockTick) }
  }, [running, load])

  async function start() {
    setBusy(true); setError('')
    try {
      const response = await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/packet-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ languages }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) setError(body.error || W.wrong)
      await load()
    } catch {
      setError(W.offline)
    }
    setBusy(false)
  }

  async function stop() {
    if (!info?.job?.jobId) return
    try { await fetch(`${backendUrl}/api/scene-lists/${sceneListId}/packet-jobs/${info.job.jobId}/stop`, { method: 'POST' }) } catch { /* the next look shows what happened */ }
    load()
  }

  if (!info || info.total === 0) return null // no characters found in the script: nothing to prepare
  const job = info.job
  const left = info.total - info.ready
  const elapsed = job?.startedAt ? (running ? Date.now() + offset.current : (job.finishedAt ?? Date.now() + offset.current)) - job.startedAt : 0
  void tick
  const percent = running && job.total ? Math.round((job.done / job.total) * 100) : Math.round((info.ready / info.total) * 100)

  return (
    <div className="ss-card sync-card packet-prep">
      <h3>{W.title}</h3>
      <p className="ss-sub">{W.sub}</p>
      {!running && (
        <p className="ss-note">
          {W.also}:{' '}
          {['en', 'hi'].map((l) => (
            <label key={l} style={{ marginRight: 12 }}>
              <input type="checkbox" checked={extra[l]} onChange={(e) => setExtra((x) => ({ ...x, [l]: e.target.checked }))} /> {W.names[l]}
            </label>
          ))}
        </p>
      )}

      <div className="packet-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,.25)', overflow: 'hidden', margin: '8px 0' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: '#2e9e5b', transition: 'width .4s' }} />
      </div>

      {running ? (
        <>
          <p className="sync-live">{W.running(job.step, job.done + job.failed.length, job.total, clock(elapsed))}</p>
          {job.notice && <p className="ss-note" role="status">🔁 {job.notice}</p>}
          <button type="button" className="ss-back" onClick={stop}>{W.stop}</button>
        </>
      ) : (
        <>
          <p className="ss-note">{left === 0 ? W.allReady(info.characters, info.ready) : W.someReady(info.ready, info.total, left)}</p>
          {left > 0 && <button type="button" className="ss-go" onClick={start} disabled={busy}>{busy ? W.starting : info.ready > 0 ? W.prepareLeft(left) : W.prepareAll}</button>}
          {job?.status === 'done' && job.failed.length === 0 && left === 0 && <p className="ss-note">{W.finished(clock(elapsed))}</p>}
          {job?.failed?.length > 0 && <p className="ss-error" role="alert">{W.failed(job.failed.length, job.failed.at(-1).error)}</p>}
          {job?.status === 'error' && job.error && <p className="ss-error" role="alert">{job.error}</p>}
          {job?.status === 'stopped' && <p className="ss-note">{W.stopped}</p>}
        </>
      )}
      {error && <p className="ss-error" role="alert">{error}</p>}
    </div>
  )
}
