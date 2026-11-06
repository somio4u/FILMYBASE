import { useCallback, useEffect, useRef, useState } from 'react'

// Adu → a script doctor's report that was uploaded with the 📎 button. While it is being read: which part, how many are done, how long. When it is read: the changes
// it asks for, grouped; the person ticks what they want. Each change is handed to Adu (as if typed): Adu shows before / after and changes nothing until "Apply".
// Reading changes nothing in the screenplay.
const TEXT = {
  en: {
    newDraft: (n) => `📋 New draft from this report (${n} change${n === 1 ? '' : 's'})`, askDraft: (n) => `Make a NEW draft with ${n} change${n === 1 ? '' : 's'} from this report? Your screenplay stays as it is. The agent first reads the whole screenplay and designs the revised story — it stops and waits for YOUR approval before it rewrites anything.`, yesDraft: 'Yes, make the new draft', no: 'No', draftStarted: (n, left) => `Started with ${n} change${n === 1 ? '' : 's'}${left > 0 ? ` (${left} smaller ones did not fit and are left for a second pass)` : ''}. The progress is in the “New draft” tab.`, starting: 'Starting…', draftFail: 'It could not start.',
    reading: (done, total, step, time) => `⏳ ${step || 'Reading the report'} · ${done}/${total} parts · ${time}`, readFail: 'The report could not be read completely:', partial: (a, b) => `Read ${a} of ${b} parts; the list below is what was found.`,
    found: (n) => `${n} change${n === 1 ? '' : 's'} found. Tick the ones you want.`, none: 'No changes were found in this report.',
    kinds: { structure: 'Story and structure', scene: 'Scene fixes', global: 'Whole-script passes', risk: 'Risks to handle', keep: 'Protect — do not change' },
    kindHelp: { structure: 'Bigger changes: they can touch many scenes or add scenes. Do these one at a time.', global: 'One instruction over the whole script — Adu shows how many scenes it would touch.', keep: 'These lines and scenes were praised. They are passed to Adu as “keep untouched” with every change.' },
    all: 'Tick all', clear: 'Clear', send: 'Send to Adu', sent: '✓ sent', sendNext: (n) => `Send the next ticked change to Adu (${n} left)`, copyFirst: '📋 First make a safe copy (a new draft)',
    copyMsg: 'Create a new draft as a safe copy of this screenplay, for the script doctor’s changes. Keep everything as it is.', sceneWord: (s) => `scene${s.length === 1 ? '' : 's'} ${s.join(', ')}`, pageWord: (p) => `p${p.join(', p')}`,
    tip: 'Tip: make a safe copy first, then send the changes one by one. Every change is shown before it is applied, and Undo is there.', severity: { critical: 'critical', major: 'major', minor: 'minor', note: '' }, more: 'details', less: 'hide',
  },
  hi: {
    newDraft: (n) => `📋 इस report से नया draft (${n} बदलाव)`, askDraft: (n) => `इस report के ${n} बदलावों से एक नया draft बनाएँ? आपकी screenplay जैसी है वैसी रहेगी। एजेंट पहले पूरी screenplay पढ़कर संशोधित कहानी बनाता है — और कुछ भी दोबारा लिखने से पहले रुककर आपकी मंज़ूरी माँगता है।`, yesDraft: 'हाँ, नया draft बनाओ', no: 'नहीं', draftStarted: (n, left) => `${n} बदलावों के साथ शुरू हो गया${left > 0 ? ` (${left} छोटे बदलाव नहीं समाए, वे दूसरी बार के लिए बचे हैं)` : ''}। प्रगति “नया draft” tab में है।`, starting: 'शुरू हो रहा है…', draftFail: 'शुरू नहीं हो सका।',
    reading: (done, total, step, time) => `⏳ ${step || 'Report पढ़ रहा हूँ'} · ${done}/${total} हिस्से · ${time}`, readFail: 'Report पूरी नहीं पढ़ी जा सकी:', partial: (a, b) => `${b} में से ${a} हिस्से पढ़े; नीचे वही सूची है जो मिली।`,
    found: (n) => `${n} बदलाव मिले। जो चाहिए उन पर टिक करो।`, none: 'इस report में कोई बदलाव नहीं मिला।',
    kinds: { structure: 'कहानी और ढाँचा', scene: 'Scene के सुधार', global: 'पूरी script पर एक-जैसे काम', risk: 'सँभालने वाले जोखिम', keep: 'बचाकर रखो — मत बदलो' },
    kindHelp: { structure: 'बड़े बदलाव: कई scenes को छू सकते हैं या scenes जोड़ सकते हैं। इन्हें एक-एक करके करो।', global: 'पूरी script पर एक निर्देश — Adu बताता है कि कितने scenes छुएगा।', keep: 'इन लाइनों और scenes की तारीफ़ हुई है। हर बदलाव के साथ ये Adu को “मत बदलना” कहकर दी जाती हैं।' },
    all: 'सब टिक करो', clear: 'हटाओ', send: 'Adu को भेजो', sent: '✓ भेजा', sendNext: (n) => `अगला टिक किया बदलाव Adu को भेजो (${n} बचे)`, copyFirst: '📋 पहले सुरक्षित copy बनाओ (नया draft)',
    copyMsg: 'इस screenplay की सुरक्षित copy के रूप में एक नया draft बनाओ, script doctor के बदलावों के लिए। बाकी सब जैसा है वैसा रखो।', sceneWord: (s) => `scene ${s.join(', ')}`, pageWord: (p) => `p${p.join(', p')}`,
    tip: 'सुझाव: पहले सुरक्षित copy बनाओ, फिर बदलाव एक-एक करके भेजो। हर बदलाव लगने से पहले दिखता है, और Undo है।', severity: { critical: 'गंभीर', major: 'बड़ा', minor: 'छोटा', note: '' }, more: 'ब्योरा', less: 'छिपाओ',
  },
  or: {
    newDraft: (n) => `📋 ଏହି ରିପୋର୍ଟରୁ ନୂଆ ଡ୍ରାଫ୍ଟ (${n} ବଦଳ)`, askDraft: (n) => `ଏହି ରିପୋର୍ଟର ${n} ବଦଳ ସହ ଗୋଟିଏ ନୂଆ ଡ୍ରାଫ୍ଟ ବନାଇବେ? ଆପଣଙ୍କ ସ୍କ୍ରିନପ୍ଲେ ଯେମିତି ଅଛି ସେମିତି ରହିବ। ଏଜେଣ୍ଟ ପ୍ରଥମେ ପୂରା ସ୍କ୍ରିନପ୍ଲେ ପଢ଼ି ସଂଶୋଧିତ କାହାଣୀ ବନାଏ — ଆଉ କିଛି ଲେଖିବା ପୂର୍ବରୁ ଆପଣଙ୍କ ଅନୁମୋଦନ ପାଇଁ ଅପେକ୍ଷା କରେ।`, yesDraft: 'ହଁ, ନୂଆ ଡ୍ରାଫ୍ଟ ବନାଅ', no: 'ନା', draftStarted: (n, left) => `${n} ବଦଳ ସହ ଆରମ୍ଭ ହେଲା${left > 0 ? ` (${left} ଛୋଟ ବଦଳ ଆଉ ଅଁଟିଲା ନାହିଁ)` : ''}। ପ୍ରଗତି “ନୂଆ ଡ୍ରାଫ୍ଟ” ଟ୍ୟାବ୍‌ରେ ଅଛି।`, starting: 'ଆରମ୍ଭ ହେଉଛି…', draftFail: 'ଆରମ୍ଭ ହୋଇପାରିଲା ନାହିଁ।',
    reading: (done, total, step, time) => `⏳ ${step || 'ରିପୋର୍ଟ ପଢ଼ୁଛି'} · ${done}/${total} ଭାଗ · ${time}`, readFail: 'ରିପୋର୍ଟ ପୂରା ପଢ଼ାଯାଇପାରିଲା ନାହିଁ:', partial: (a, b) => `${b} ମଧ୍ୟରୁ ${a} ଭାଗ ପଢ଼ାଗଲା; ତଳେ ଯାହା ମିଳିଲା ତାହା।`,
    found: (n) => `${n}ଟି ବଦଳ ମିଳିଲା। ଯାହା ଚାହାଁନ୍ତି ସେଥିରେ ଟିକ୍ କରନ୍ତୁ।`, none: 'ଏହି ରିପୋର୍ଟରେ କୌଣସି ବଦଳ ମିଳିଲା ନାହିଁ।',
    kinds: { structure: 'କାହାଣୀ ଓ ଢାଞ୍ଚା', scene: 'ସିନ୍ ସୁଧାର', global: 'ପୂରା ସ୍କ୍ରିପ୍ଟ ଉପରେ କାମ', risk: 'ସମ୍ଭାଳିବାର ବିପଦ', keep: 'ରଖ — ବଦଳାନାହିଁ' },
    kindHelp: { structure: 'ବଡ଼ ବଦଳ: ଅନେକ ସିନ୍ ଛୁଇଁପାରେ। ଗୋଟି ଗୋଟି କରି କରନ୍ତୁ।', global: 'ପୂରା ସ୍କ୍ରିପ୍ଟ ଉପରେ ଗୋଟିଏ ନିର୍ଦ୍ଦେଶ।', keep: 'ଏହି ଧାଡ଼ି ଓ ସିନ୍‌ର ପ୍ରଶଂସା ହୋଇଛି। ପ୍ରତ୍ୟେକ ବଦଳ ସହ ଏଗୁଡ଼ିକ Adu କୁ “ବଦଳାନାହିଁ” ବୋଲି ଦିଆଯାଏ।' },
    all: 'ସବୁ ଟିକ୍', clear: 'ହଟାଅ', send: 'Adu କୁ ପଠାଅ', sent: '✓ ପଠାଗଲା', sendNext: (n) => `ପରବର୍ତ୍ତୀ ଟିକ୍ ବଦଳ Adu କୁ ପଠାଅ (${n} ବାକି)`, copyFirst: '📋 ପ୍ରଥମେ ସୁରକ୍ଷିତ କପି (ନୂଆ ଡ୍ରାଫ୍ଟ)',
    copyMsg: 'ଏହି ସ୍କ୍ରିନପ୍ଲେର ସୁରକ୍ଷିତ କପି ଭାବେ ଗୋଟିଏ ନୂଆ ଡ୍ରାଫ୍ଟ ବନାଅ, script doctor ଙ୍କ ବଦଳ ପାଇଁ। ବାକି ସବୁ ଯେମିତି ଅଛି ସେମିତି ରଖ।', sceneWord: (s) => `ସିନ୍ ${s.join(', ')}`, pageWord: (p) => `p${p.join(', p')}`,
    tip: 'ପରାମର୍ଶ: ପ୍ରଥମେ ସୁରକ୍ଷିତ କପି କରନ୍ତୁ, ତା’ପରେ ବଦଳ ଗୋଟି ଗୋଟି କରି ପଠାନ୍ତୁ। ପ୍ରତ୍ୟେକ ବଦଳ ଲାଗିବା ପୂର୍ବରୁ ଦେଖାଯାଏ, Undo ଅଛି।', severity: { critical: 'ଗୁରୁତର', major: 'ବଡ଼', minor: 'ଛୋଟ', note: '' }, more: 'ବିବରଣୀ', less: 'ଲୁଚାଅ',
  },
}

const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }
const call = async (url, method = 'GET', body) => {
  try {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { ok: response.ok, data: await response.json().catch(() => ({})) }
  } catch { return { ok: false, data: {} } }
}

// what is handed to Adu for one change (the same sentence the server's instructionFor builds)
export function instructionFor(item, keeps) {
  const where = item.scenes?.length ? ` (scene${item.scenes.length === 1 ? '' : 's'} ${item.scenes.join(', ')})` : ''
  const kept = keeps.filter((k) => k.id !== item.id).slice(0, 8).map((k) => `“${k.action.slice(0, 120)}”`)
  return `${item.action}${where}${kept.length ? ` — but keep these untouched: ${kept.join('; ')}` : ''}`.slice(0, 1800)
}

export default function AduReportCard({ backendUrl, projectId, action, lang = 'en', onSendToChat, draftId = null, onOpenRevision = null }) {
  const L = TEXT[lang] ?? TEXT.en
  const api = `${backendUrl}/api/ai-movie/assistant/${projectId}/report/${action.readId}`
  const [read, setRead] = useState(null)
  const [selected, setSelected] = useState([])
  const [sent, setSent] = useState([])
  const [open, setOpen] = useState({})
  const [now, setNow] = useState(Date.now())
  const [asking, setAsking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [draftNote, setDraftNote] = useState('')
  const [draftError, setDraftError] = useState('')
  const offset = useRef(0)
  const alive = useRef(true)

  const load = useCallback(async () => {
    const r = await call(api)
    if (!alive.current || !r.ok) return null
    setRead(r.data); setSelected((s) => (s.length || !r.data.selected?.length ? s : r.data.selected)); setSent(r.data.sent ?? [])
    return r.data
  }, [api])
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false } }, [load])
  const reading = read && read.partsDone < read.parts && read.job?.status !== 'error' && read.job?.status !== 'stopped'
  useEffect(() => {
    if (!reading) return undefined
    const poll = setInterval(load, 3000); const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(poll); clearInterval(tick) }
  }, [reading, load])

  const persist = (next, extra = {}) => { setSelected(next); call(`${api}/selection`, 'PUT', { selected: next, ...extra }) }
  const toggle = (id) => persist(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  const keeps = (read?.items ?? []).filter((i) => i.kind === 'keep')
  const sendItem = (item) => { onSendToChat?.(instructionFor(item, keeps)); const nextSent = [...new Set([...sent, item.id])]; setSent(nextSent); persist(selected, { sent: [item.id] }) }
  const doable = (read?.items ?? []).filter((i) => i.kind !== 'keep')
  const forDraft = selected.length ? doable.filter((i) => selected.includes(i.id)) : doable // ticked ones, or all when none is ticked
  async function newDraft() {
    setAsking(false); setStarting(true); setDraftError(''); setDraftNote('')
    const r = await call(`${api}/new-draft`, 'POST', { draftId })
    setStarting(false)
    if (!r.ok) { setDraftError(r.data.error || L.draftFail); return }
    setDraftNote(L.draftStarted(r.data.included, r.data.left))
    const id = r.data.request?.id
    if (id) onOpenRevision?.(id)
  }
  const todo = (read?.items ?? []).filter((i) => i.kind !== 'keep' && selected.includes(i.id) && !sent.includes(i.id))

  if (!read) return <small>…</small>
  const started = read.job?.startedAt ? read.job.startedAt : new Date(read.createdAt).getTime()
  const elapsed = (reading ? Date.now() : (read.job?.finishedAt ?? Date.now())) - started
  void now

  return (
    <div className="adu-card adu-report">
      {reading && (
        <>
          <div role="progressbar" aria-valuenow={read.partsDone} aria-valuemin={0} aria-valuemax={read.parts} style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,.25)', overflow: 'hidden', margin: '6px 0' }}>
            <div style={{ width: `${Math.round((read.partsDone / Math.max(1, read.parts)) * 100)}%`, height: '100%', background: '#2e9e5b', transition: 'width .4s' }} />
          </div>
          <p className="dd-note" role="status">{L.reading(read.partsDone, read.parts, read.job?.step, clock(elapsed))}</p>
        </>
      )}
      {!reading && read.partsDone < read.parts && (
        <p className="dd-error" role="alert">{L.readFail} {read.job?.failed?.[0]?.error || read.job?.error || ''} <br />{L.partial(read.partsDone, read.parts)}</p>
      )}
      {!reading && read.items.length === 0 && read.partsDone >= read.parts && <p className="dd-note">{L.none}</p>}
      {read.items.length > 0 && (
        <>
          <p className="dd-note"><strong>{L.found(read.items.filter((i) => i.kind !== 'keep').length)}</strong></p>
          <p className="dd-note">{L.tip}</p>
          {!asking ? (
            <div className="dd-actions">
              <button type="button" className="dd-btn primary" disabled={starting || !draftId || forDraft.length === 0} onClick={() => setAsking(true)}>{starting ? L.starting : L.newDraft(forDraft.length)}</button>
            </div>
          ) : (
            <div className="dd-note" role="alertdialog">
              <p>{L.askDraft(forDraft.length)}</p>
              <button type="button" className="dd-btn primary" onClick={newDraft}>{L.yesDraft}</button>{' '}
              <button type="button" className="dd-btn" onClick={() => setAsking(false)}>{L.no}</button>
            </div>
          )}
          {draftNote && <p className="dd-note" role="status">{draftNote}</p>}
          {draftError && <p className="dd-error" role="alert">{draftError}</p>}
          <div className="dd-actions">
            <button type="button" className="dd-btn" onClick={() => onSendToChat?.(L.copyMsg)}>{L.copyFirst}</button>
            <button type="button" className="dd-btn primary" disabled={todo.length === 0} onClick={() => sendItem(todo[0])}>{L.sendNext(todo.length)}</button>
          </div>
          {read.groups.map((g) => (
            <details key={g.kind} open={g.kind !== 'keep'} className="adu-report-group">
              <summary><strong>{L.kinds[g.kind]}</strong> ({g.items.length})</summary>
              {L.kindHelp[g.kind] && <p className="dd-note">{L.kindHelp[g.kind]}</p>}
              {g.kind !== 'keep' && (
                <p>
                  <button type="button" className="dd-btn" onClick={() => persist([...new Set([...selected, ...g.items.map((i) => i.id)])])}>{L.all}</button>{' '}
                  <button type="button" className="dd-btn" onClick={() => persist(selected.filter((id) => !g.items.some((i) => i.id === id)))}>{L.clear}</button>
                </p>
              )}
              <ul className="adu-report-list">
                {g.items.map((item) => (
                  <li key={item.id} className={`adu-report-item is-${item.severity}`}>
                    {g.kind !== 'keep' && <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} aria-label={item.title} />}{' '}
                    <strong>{item.title}</strong>
                    {L.severity[item.severity] ? <small className="adu-report-sev"> · {L.severity[item.severity]}</small> : null}
                    {item.scenes?.length ? <small> · {L.sceneWord(item.scenes)}</small> : null}
                    {item.pages?.length && !item.scenes?.length ? <small> · {L.pageWord(item.pages)}</small> : null}
                    <div>
                      <button type="button" className="buddy-link" onClick={() => setOpen((o) => ({ ...o, [item.id]: !o[item.id] }))}>{open[item.id] ? L.less : L.more}</button>
                      {g.kind !== 'keep' && (sent.includes(item.id) ? <small> {L.sent}</small> : <> <button type="button" className="buddy-link" onClick={() => sendItem(item)}>{L.send}</button></>)}
                    </div>
                    {open[item.id] && <p className="adu-report-text">{item.action}</p>}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </>
      )}
    </div>
  )
}
