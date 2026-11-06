import { useCallback, useEffect, useRef, useState } from 'react'
import './Drafts.css'

// The cards under Adu's replies (step H3): what Adu PROPOSES, with the button that does it. Nothing is changed, copied or paid for until a button is pressed;
// every button calls a route that already exists (the Draft Agent's propose / apply / undo / alternative / revision / new-story, the whole-screenplay job,
// Extend a beat), and "no thanks" just closes the card. A card that was pressed is remembered on the server (…/resolve), so it does not come back after a reload.
const W = {
  en: {
    someFailed: (n, total, why) => `⚠ ${n} of ${total} could not be done. ${why}`, nothingDone: (why) => `⚠ Nothing could be done. ${why}`, stoppedNote: '■ Stopped.',
    filmWriteBtn: (n) => `✍ Write the ${n} scene${n === 1 ? '' : 's'} not written yet`, filmAddBtn: (n) => `➕ Add ${n} scene${n === 1 ? '' : 's'} to the scene list`, filmStop: 'Stop after this scene', filmRunning: (step, done, total) => `⏳ ${step} · ${done}/${total}`, filmDone: '✓ The job has finished — see the Scene List and Screenplay cards.', filmStarted: 'Started. It runs in the background; the progress is here and on the card:',
    older: 'An older suggestion — ask again if you still want it.', done: '✓ Done', dismissed: 'No thanks — closed.', no: 'No thanks',
    writeBtn: '✍ Start writing the whole screenplay', writeStarted: 'Started. The progress is on the Screenplay card, and here:', stop: 'Stop after this beat',
    running: (step, done, total) => `⏳ ${step} · ${done}/${total}`, writeDone: '✓ The writing job has finished — see the Screenplay card.',
    extendBtn: (n) => `Add scenes to beat ${n}`, extending: 'Adding scenes… this can take a minute', extended: (n, m, t) => `✓ Beat ${n} now has about ${m} of its ${t} minutes. It is waiting for your look again.`,
    showChange: 'Show me the change', showing: 'Preparing the preview…', previewThese: 'Show the change for these pieces', pick: 'Which pieces?', before: 'Before', after: 'After',
    nothingChanged: 'The AI did not change anything.', changes: (n) => `${n} piece${n === 1 ? '' : 's'} would change`, apply: 'Apply to this draft', applying: 'Applying…', applied: '✓ Applied to this draft', undo: 'Undo', undone: 'Undone — the draft is as it was.',
    approvedDraft: 'This draft is approved. Edit it anyway? (A new draft keeps it safe.)', locked: 'This draft is locked, so it cannot be edited here.',
    altBtn: 'Try it as an alternative (a copy)', altMaking: 'Making the alternative…', altMade: 'The alternative is made as a separate copy; your draft is unchanged.', openDrafts: 'Open the Drafts list',
    newDraftNote: 'This makes a COPY as the next draft and analyses the whole screenplay. It stops at the revised synopsis for your approval before any scene is rewritten.', newDraftBtn: 'Yes — make a new draft', newDraftMaking: 'Making the new draft…',
    storyHere: 'A new draft in this project', storyNew: 'A separate new project', storyIdea: 'The new story idea…', storyBtn: 'Create it',
    continueBtn: 'Continue this draft where it stopped', choose: 'What should I do?', failed: 'That did not work.',
  },
  hi: {
    someFailed: (n, total, why) => `⚠ ${total} में से ${n} नहीं हो पाए। ${why}`, nothingDone: (why) => `⚠ कुछ भी नहीं हो पाया। ${why}`, stoppedNote: '■ रोक दिया गया।',
    filmWriteBtn: (n) => `✍ अभी तक न लिखे ${n} scenes लिखो`, filmAddBtn: (n) => `➕ Scene list में ${n} scenes जोड़ो`, filmStop: 'इस scene के बाद रोको', filmRunning: (step, done, total) => `⏳ ${step} · ${done}/${total}`, filmDone: '✓ काम पूरा हो गया — Scene List और Screenplay card देखो।', filmStarted: 'शुरू हो गया। यह background में चलता है; प्रगति यहाँ और card पर है:',
    older: 'यह पुराना सुझाव है — अब भी चाहिए तो फिर से कहो।', done: '✓ हो गया', dismissed: 'रहने दिया — बंद।', no: 'रहने दो',
    writeBtn: '✍ पूरी screenplay लिखना शुरू करो', writeStarted: 'शुरू हो गया। प्रगति Screenplay card पर है, और यहाँ भी:', stop: 'इस beat के बाद रोको',
    running: (step, done, total) => `⏳ ${step} · ${done}/${total}`, writeDone: '✓ लिखने का काम पूरा हो गया — Screenplay card देखो।',
    extendBtn: (n) => `beat ${n} में scenes जोड़ो`, extending: 'scenes जोड़ रहा हूँ… इसमें एक मिनट लग सकता है', extended: (n, m, t) => `✓ अब beat ${n} में ${t} में से करीब ${m} मिनट हैं। वह आपकी नज़र का इंतज़ार कर रहा है।`,
    showChange: 'मुझे बदलाव दिखाओ', showing: 'झलक बन रही है…', previewThese: 'इन हिस्सों का बदलाव दिखाओ', pick: 'कौन से हिस्से?', before: 'पहले', after: 'बाद में',
    nothingChanged: 'AI ने कुछ नहीं बदला।', changes: (n) => `${n} हिस्से बदलेंगे`, apply: 'इस draft में लागू करो', applying: 'लागू हो रहा है…', applied: '✓ इस draft में लागू हो गया', undo: 'वापस करो', undone: 'वापस हो गया — draft जैसा था वैसा है।',
    approvedDraft: 'यह draft approved है। फिर भी बदलें? (नया draft इसे सुरक्षित रखता है।)', locked: 'यह draft locked है, इसलिए यहाँ नहीं बदला जा सकता।',
    altBtn: 'इसे alternative (नकल) में आज़माओ', altMaking: 'alternative बन रहा है…', altMade: 'alternative एक अलग नकल के रूप में बन गया; आपका draft वैसा ही है।', openDrafts: 'Drafts की सूची खोलो',
    newDraftNote: 'इससे अगले draft के रूप में एक नकल बनती है और पूरी screenplay का विश्लेषण होता है। कोई भी scene दोबारा लिखे जाने से पहले यह संशोधित synopsis पर आपके approval के लिए रुक जाता है।', newDraftBtn: 'हाँ — नया draft बनाओ', newDraftMaking: 'नया draft बन रहा है…',
    storyHere: 'इसी project में एक नया draft', storyNew: 'एक अलग नया project', storyIdea: 'नई कहानी का idea…', storyBtn: 'बनाओ',
    continueBtn: 'इस draft को जहाँ रुका था वहीं से जारी रखो', choose: 'मुझे क्या करना है?', failed: 'यह नहीं हो पाया।',
  },
  or: {
    someFailed: (n, total, why) => `⚠ ${total} ମଧ୍ୟରୁ ${n} ହୋଇପାରିଲା ନାହିଁ। ${why}`, nothingDone: (why) => `⚠ କିଛି ହୋଇପାରିଲା ନାହିଁ। ${why}`, stoppedNote: '■ ବନ୍ଦ କରାଗଲା।',
    filmWriteBtn: (n) => `✍ ଏଯାଏଁ ଲେଖା ହୋଇନଥିବା ${n} ଦୃଶ୍ୟ ଲେଖ`, filmAddBtn: (n) => `➕ ସିନ୍ ତାଲିକାରେ ${n} ଦୃଶ୍ୟ ଯୋଡ଼`, filmStop: 'ଏହି ଦୃଶ୍ୟ ପରେ ଅଟକାଅ', filmRunning: (step, done, total) => `⏳ ${step} · ${done}/${total}`, filmDone: '✓ କାମ ସରିଲା — Scene List ଓ Screenplay କାର୍ଡ ଦେଖ।', filmStarted: 'ଆରମ୍ଭ ହୋଇଗଲା। ଏହା background ରେ ଚାଲେ; ପ୍ରଗତି ଏଠି ଏବଂ କାର୍ଡରେ:',
    older: 'ଏହା ପୁରୁଣା ପରାମର୍ଶ — ଏବେ ବି ଦରକାର ହେଲେ ପୁଣି କୁହ।', done: '✓ ହୋଇଗଲା', dismissed: 'ରହିଲା — ବନ୍ଦ।', no: 'ରହୁ',
    writeBtn: '✍ ପୁରା ସ୍କ୍ରିନପ୍ଲେ ଲେଖିବା ଆରମ୍ଭ କର', writeStarted: 'ଆରମ୍ଭ ହୋଇଗଲା। ପ୍ରଗତି Screenplay କାର୍ଡରେ ଅଛି, ଏବଂ ଏଠି ମଧ୍ୟ:', stop: 'ଏହି ବିଟ୍ ପରେ ଅଟକାଅ',
    running: (step, done, total) => `⏳ ${step} · ${done}/${total}`, writeDone: '✓ ଲେଖିବା କାମ ସରିଲା — Screenplay କାର୍ଡ ଦେଖ।',
    extendBtn: (n) => `beat ${n} ରେ ଦୃଶ୍ୟ ଯୋଡ଼`, extending: 'ଦୃଶ୍ୟ ଯୋଡ଼ୁଛି… ଏଥିରେ ଏକ ମିନିଟ୍ ଲାଗିପାରେ', extended: (n, m, t) => `✓ ଏବେ beat ${n} ରେ ${t} ମଧ୍ୟରୁ ପ୍ରାୟ ${m} ମିନିଟ୍ ଅଛି। ସେ ତୁମ ଦୃଷ୍ଟିକୁ ଅପେକ୍ଷା କରୁଛି।`,
    showChange: 'ମତେ ବଦଳ ଦେଖାଅ', showing: 'ଝଲକ ତିଆରି ହେଉଛି…', previewThese: 'ଏହି ଅଂଶଗୁଡ଼ିକର ବଦଳ ଦେଖାଅ', pick: 'କେଉଁ ଅଂଶ?', before: 'ଆଗରୁ', after: 'ପରେ',
    nothingChanged: 'AI କିଛି ବଦଳାଇଲା ନାହିଁ।', changes: (n) => `${n} ଟି ଅଂଶ ବଦଳିବ`, apply: 'ଏହି ଡ୍ରାଫ୍ଟରେ ଲାଗୁ କର', applying: 'ଲାଗୁ ହେଉଛି…', applied: '✓ ଏହି ଡ୍ରାଫ୍ଟରେ ଲାଗୁ ହୋଇଗଲା', undo: 'ଫେରାଅ', undone: 'ଫେରିଗଲା — ଡ୍ରାଫ୍ଟ ଯେମିତି ଥିଲା ସେମିତି ଅଛି।',
    approvedDraft: 'ଏହି ଡ୍ରାଫ୍ଟ ଅନୁମୋଦିତ। ତଥାପି ବଦଳାଇବ? (ନୂଆ ଡ୍ରାଫ୍ଟ ଏହାକୁ ସୁରକ୍ଷିତ ରଖେ।)', locked: 'ଏହି ଡ୍ରାଫ୍ଟ ଲକ୍ ହୋଇଛି, ତେଣୁ ଏଠି ବଦଳାଇ ହେବ ନାହିଁ।',
    altBtn: 'ଏହାକୁ alternative (ନକଲ) ରେ ଚେଷ୍ଟା କର', altMaking: 'alternative ତିଆରି ହେଉଛି…', altMade: 'alternative ଅଲଗା ନକଲ ଭାବେ ତିଆରି ହେଲା; ତୁମ ଡ୍ରାଫ୍ଟ ଯେମିତି ଅଛି ସେମିତି।', openDrafts: 'ଡ୍ରାଫ୍ଟ ତାଲିକା ଖୋଲ',
    newDraftNote: 'ଏହା ପରବର୍ତ୍ତୀ ଡ୍ରାଫ୍ଟ ଭାବେ ଏକ ନକଲ ତିଆରି କରେ ଓ ପୁରା ସ୍କ୍ରିନପ୍ଲେର ବିଶ୍ଳେଷଣ କରେ। କୌଣସି ଦୃଶ୍ୟ ପୁଣି ଲେଖିବା ଆଗରୁ ସଂଶୋଧିତ ସିନୋପସିସ୍ ଉପରେ ତୁମ ଅନୁମୋଦନ ପାଇଁ ଅଟକିଯାଏ।', newDraftBtn: 'ହଁ — ନୂଆ ଡ୍ରାଫ୍ଟ ବନାଅ', newDraftMaking: 'ନୂଆ ଡ୍ରାଫ୍ଟ ତିଆରି ହେଉଛି…',
    storyHere: 'ଏହି ପ୍ରୋଜେକ୍ଟରେ ଏକ ନୂଆ ଡ୍ରାଫ୍ଟ', storyNew: 'ଏକ ଅଲଗା ନୂଆ ପ୍ରୋଜେକ୍ଟ', storyIdea: 'ନୂଆ ଗପର ଆଇଡିଆ…', storyBtn: 'ବନାଅ',
    continueBtn: 'ଏହି ଡ୍ରାଫ୍ଟକୁ ଯେଉଁଠି ଅଟକିଥିଲା ସେଇଠୁ ଜାରି ରଖ', choose: 'ମୁଁ କଣ କରିବି?', failed: 'ଏହା ହେଲା ନାହିଁ।',
  },
}

async function call(url, method = 'GET', body) {
  try {
    const r = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } }
  }
}

function Diff({ edit, L }) {
  return (
    <li className="da-edit">
      <strong>{edit.label}</strong>
      <div className="dd-sides"><div><h5>{L.before}</h5><pre>{edit.beforeText}</pre></div><div><h5>{L.after}</h5><pre>{edit.afterText}</pre></div></div>
    </li>
  )
}

// what to say when a background job is no longer running: done, or honestly how much failed (never "done" over a failure)
function finishedNote(job, L, doneText) {
  const failed = job.failed?.length ?? 0
  if (failed > 0) {
    const why = String(job.failed[0]?.error ?? '').replace(/\s+/g, ' ').slice(0, 160)
    return job.done > 0 ? L.someFailed(failed, job.total, why) : L.nothingDone(why)
  }
  if (job.stopRequested && job.done < job.total) return `${L.stoppedNote} ${job.done}/${job.total}`
  return doneText
}

// the progress of the whole-screenplay job, shown under the card that started it
function WriteMini({ backendUrl, projectId, L, onFinished }) {
  const [job, setJob] = useState(null)
  const finishedRef = useRef(onFinished)
  finishedRef.current = onFinished
  const load = useCallback(async () => {
    const r = await call(`${backendUrl}/api/ai-movie/projects/${projectId}/write-all/current`)
    if (r.ok) { setJob(r.data.jobId ? r.data : null); if (r.data.jobId && r.data.status !== 'running') finishedRef.current?.() }
    return r.data
  }, [backendUrl, projectId])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (job?.status !== 'running') return undefined
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [job?.status, load])
  if (!job) return null
  if (job.status === 'running') {
    return (
      <div className="dd-note" role="status">
        <p>{L.running(job.step, job.done + (job.failed?.length ?? 0), job.total)}</p>
        <progress max={job.total} value={job.done + (job.failed?.length ?? 0)} />
        {!job.stopRequested && <button type="button" className="dd-btn" onClick={async () => { await call(`${backendUrl}/api/ai-movie/projects/${projectId}/write-all/${job.jobId}/stop`, 'POST'); load() }}>{L.stop}</button>}
      </div>
    )
  }
  return <p className="dd-note">{finishedNote(job, L, L.writeDone)}</p>
}

// the progress of a film's background writing job (write the scenes / add scenes), shown under the card that started it
function FilmMini({ backendUrl, sceneListId, L, onFinished }) {
  const [job, setJob] = useState(null)
  const finishedRef = useRef(onFinished)
  finishedRef.current = onFinished
  const load = useCallback(async () => {
    const r = await call(`${backendUrl}/api/scene-lists/${sceneListId}/write-jobs/current`)
    if (r.ok) { setJob(r.data.jobId ? r.data : null); if (r.data.jobId && r.data.status !== 'running') finishedRef.current?.() }
    return r.data
  }, [backendUrl, sceneListId])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (job?.status !== 'running') return undefined
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [job?.status, load])
  if (!job) return null
  if (job.status === 'running') {
    const finished = job.done + (job.failed?.length ?? 0)
    return (
      <div className="dd-note" role="status">
        <p>{L.filmRunning(job.step, finished, job.total)}</p>
        <progress max={job.total} value={finished} />
        {!job.stopRequested && <button type="button" className="dd-btn" onClick={async () => { await call(`${backendUrl}/api/scene-lists/${sceneListId}/write-jobs/${job.jobId}/stop`, 'POST'); load() }}>{L.filmStop}</button>}
      </div>
    )
  }
  return <p className="dd-note">{finishedNote(job, L, L.filmDone)}</p>
}

export default function AduAction({ message, action, current, update, lang = 'en', ctx }) {
  const L = W[lang] ?? W.en
  const { backendUrl, projectId, draft, getContext, onApplied, onOpenDraft, onOpenRevision, module = 'ai_movie' } = ctx
  const assistantApi = `${backendUrl}/api/${module === 'film' ? 'film' : 'ai-movie'}/assistant/${projectId}`
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [override, setOverride] = useState(null)
  const [picked, setPicked] = useState(() => (action.targets ?? []).map((t) => t.key))
  const [cs, setCs] = useState(null)
  const [story, setStory] = useState({ destination: 'same_project', idea: action.instruction ?? '' })
  const [started, setStarted] = useState(false)
  const intent = override ?? action.intent
  const agentApi = `${backendUrl}/api/drafts/${action.draftId}/agent`
  const context = () => ({ ...(getContext?.() ?? {}), stage: (getContext?.() ?? {}).stage ?? 'screenplay' })
  const body = () => ({ instruction: action.instruction, intent, targetKeys: picked, context: context(), constraints: action.constraints ?? {}, confirmed: true })

  async function resolve(outcome) {
    const r = await call(`${assistantApi}/resolve`, 'POST', { messageId: message.id, outcome })
    if (r.ok) update({ resolved: true, action: { ...action, outcome } })
  }
  async function run(label, fn) {
    if (busy) return null
    setBusy(label); setError('')
    const r = await fn()
    setBusy('')
    if (!r.ok) { setError(r.data.error ?? L.failed); return null }
    return r.data
  }

  // ---- already pressed: just say so (and keep showing the job's progress)
  if (message.resolved || action.outcome) {
    return (
      <div className="adu-card-done">
        <small>{action.outcome === 'dismissed' ? L.dismissed : L.done}</small>
        {(action.type === 'write_scenes' || action.type === 'add_scenes') && action.outcome === 'applied' && <FilmMini backendUrl={backendUrl} sceneListId={action.sceneListId} L={L} onFinished={onApplied} />}
        {action.type === 'write_all' && action.outcome === 'applied' && <WriteMini backendUrl={backendUrl} projectId={projectId} L={L} onFinished={onApplied} />}
        {cs?.status === 'applied' && <p className="dd-note">{L.applied}</p>}
      </div>
    )
  }
  if (!current) return <small>{L.older}</small>

  const dismiss = <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={() => resolve('dismissed')}>{L.no}</button>
  const errorLine = error && <p className="dd-error" role="alert">{error}</p>
  const noteLine = note && <p className="dd-note" role="status">{note}</p>

  // ---- write the whole screenplay
  if (action.type === 'write_all') {
    return (
      <div className="adu-card">
        {!started ? (
          <div className="dd-actions">
            <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => {
              const d = await run('write', () => call(`${backendUrl}/api/ai-movie/projects/${projectId}/write-all`, 'POST', { dialogue: action.dialogue }))
              if (d) { setStarted(true); setNote(L.writeStarted); await resolve('applied') }
            }}>{L.writeBtn}</button>
            {dismiss}
          </div>
        ) : null}
        {noteLine}{errorLine}
      </div>
    )
  }

  // ---- a film: write the scenes not written yet / add scenes to the scene list (the film's own background job)
  if (action.type === 'write_scenes' || action.type === 'add_scenes') {
    const adding = action.type === 'add_scenes'
    return (
      <div className="adu-card">
        {!started ? (
          <div className="dd-actions">
            <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => {
              const d = await run('film', () => call(`${backendUrl}/api/scene-lists/${action.sceneListId}/write-jobs`, 'POST', adding ? { scope: 'add', count: action.count } : { scope: 'all' }))
              if (d) { setStarted(true); setNote(L.filmStarted); await resolve('applied') }
            }}>{adding ? L.filmAddBtn(action.count) : L.filmWriteBtn(action.unwritten)}</button>
            {dismiss}
          </div>
        ) : null}
        {noteLine}{errorLine}
        {started && <FilmMini backendUrl={backendUrl} sceneListId={action.sceneListId} L={L} onFinished={onApplied} />}
      </div>
    )
  }

  // ---- make a beat longer (to its own Beat Sheet time)
  if (action.type === 'extend_beat') {
    if (!action.canExtend) return null // the reply already says why there is nothing to do
    return (
      <div className="adu-card">
        <div className="dd-actions">
          <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => {
            const d = await run('extend', () => call(`${backendUrl}/api/ai-movie/stages/screenplay/beats/${action.beatIndex}/extend-to-target`, 'POST', { projectId }))
            if (d) { setNote(L.extended(action.beatIndex + 1, d.totalMinutes, d.targetMinutes)); onApplied?.(); await resolve('applied') }
          }}>{busy === 'extend' ? L.extending : L.extendBtn(action.beatIndex + 1)}</button>
          {dismiss}
        </div>
        {noteLine}{errorLine}
      </div>
    )
  }

  // ---- everything that goes through the Draft Agent
  if (action.type === 'agent') {
    const editLike = ['LOCAL_EDIT', 'SCOPED_REWRITE'].includes(intent)
    const editable = !['locked', 'archived'].includes(draft?.status)
    const needsChoice = action.needsClarification && !override
    const candidates = action.candidates ?? []
    const propose = async () => { const d = await run('propose', () => call(`${agentApi}/propose`, 'POST', body())); if (d) setCs(d.changeSet) }
    return (
      <div className="adu-card">
        {errorLine}{noteLine}
        {needsChoice && candidates.length > 0 && editLike === false && null}
        {needsChoice && (action.unresolved?.length > 0 || candidates.length > 0) && (
          <details open className="da-picker">
            <summary>{L.pick}</summary>
            <ul>{candidates.map((c) => (
              <li key={c.key}><label><input type="checkbox" checked={picked.includes(c.key)} onChange={() => setPicked((p) => (p.includes(c.key) ? p.filter((k) => k !== c.key) : [...p, c.key]))} /> {c.label}</label></li>
            ))}</ul>
            <button type="button" className="dd-btn primary" disabled={!picked.length || Boolean(busy)} onClick={propose}>{busy === 'propose' ? L.showing : L.previewThese}</button>
          </details>
        )}
        {needsChoice && !(action.unresolved?.length > 0 || candidates.length > 0) && (
          <div className="dd-actions">
            <small>{L.choose}</small>
            {(action.options ?? []).map((c) => <button key={c.action} type="button" className="dd-btn" onClick={() => setOverride(c.intent)}>{c.label}</button>)}
          </div>
        )}

        {!needsChoice && editLike && !cs && (
          <div className="dd-actions">
            {editable ? <button type="button" className="dd-btn primary" disabled={!picked.length || Boolean(busy)} onClick={propose}>{busy === 'propose' ? L.showing : L.showChange}</button> : <small>{L.locked}</small>}
            {dismiss}
          </div>
        )}
        {cs && (
          <div className="da-preview">
            <h5>{L.changes(cs.changes)}{cs.status === 'applied' ? ' ✓' : ''}</h5>
            {cs.failures?.map((f, i) => <p key={i} className="dd-flag">{f.key}: {f.message}</p>)}
            {cs.changes === 0 && <p className="dd-note">{L.nothingChanged}</p>}
            <ul className="da-edits">{cs.edits.map((e) => <Diff key={e.key} edit={e} L={L} />)}</ul>
            <div className="dd-actions">
              {cs.status === 'proposed' && cs.changes > 0 && <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => {
                const confirmEdit = draft?.status === 'approved'
                if (confirmEdit && !window.confirm(L.approvedDraft)) return
                const d = await run('apply', () => call(`${backendUrl}/api/drafts/change-sets/${cs.id}/apply`, 'POST', { confirmEditApproved: confirmEdit }))
                if (d) { setCs(d.changeSet); onApplied?.(); await resolve('applied') }
              }}>{busy === 'apply' ? L.applying : L.apply}</button>}
              {cs.status === 'proposed' && <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={async () => { const d = await run('reject', () => call(`${backendUrl}/api/drafts/change-sets/${cs.id}/reject`, 'POST', {})); if (d) { setCs(d.changeSet); await resolve('dismissed') } }}>{L.no}</button>}
            </div>
          </div>
        )}

        {!needsChoice && intent === 'ALTERNATIVE' && (
          <div className="dd-actions">
            <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => {
              const d = await run('alt', () => call(`${agentApi}/alternative`, 'POST', body()))
              if (d) { setNote(L.altMade); await resolve('applied') }
            }}>{busy === 'alt' ? L.altMaking : L.altBtn}</button>
            <button type="button" className="dd-btn" onClick={() => onOpenDraft?.('dashboard')}>{L.openDrafts}</button>
            {dismiss}
          </div>
        )}
        {!needsChoice && intent === 'NEW_DRAFT' && (
          <>
            <p className="dd-fine">{L.newDraftNote}</p>
            <div className="dd-actions">
              <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => {
                const d = await run('rev', () => call(`${agentApi}/revision`, 'POST', { instruction: action.instruction, source: 'chat', context: context(), constraints: action.constraints ?? {}, confirmed: true }))
                if (d) { await resolve('applied'); onApplied?.(); onOpenRevision?.(d.request.id) }
              }}>{busy === 'rev' ? L.newDraftMaking : L.newDraftBtn}</button>
              {dismiss}
            </div>
          </>
        )}
        {!needsChoice && intent === 'NEW_STORY' && (
          <div className="da-newstory">
            <label><input type="radio" checked={story.destination === 'same_project'} onChange={() => setStory({ ...story, destination: 'same_project' })} /> {L.storyHere}</label>
            <label><input type="radio" checked={story.destination === 'new_project'} onChange={() => setStory({ ...story, destination: 'new_project' })} /> {L.storyNew}</label>
            <textarea rows={2} value={story.idea} onChange={(e) => setStory({ ...story, idea: e.target.value })} placeholder={L.storyIdea} />
            <div className="dd-actions">
              <button type="button" className="dd-btn primary" disabled={!story.idea.trim() || Boolean(busy)} onClick={async () => { const d = await run('story', () => call(`${agentApi}/new-story`, 'POST', story)); if (d) { await resolve('applied'); onOpenDraft?.('open-new', d) } }}>{L.storyBtn}</button>
              {dismiss}
            </div>
          </div>
        )}
        {!needsChoice && intent === 'CONTINUE' && (
          <div className="dd-actions">
            <button type="button" className="dd-btn primary" onClick={async () => { await resolve('applied'); onOpenDraft?.('continue') }}>{L.continueBtn}</button>
            {dismiss}
          </div>
        )}
      </div>
    )
  }
  return null
}
