import { useCallback, useEffect, useState } from 'react'

// AI Movie → "Rename a character in the whole script" (the same tool the Movie screenplay has). Check first (it only counts), then rename everywhere; "Undo" puts
// the text back exactly as it was before the last rename. Nothing here calls the AI.
const TEXT = {
  en: {
    open: '✎ Rename a character', title: 'Rename a character in the whole script', from: 'Old name', to: 'New name', check: 'Check', go: 'Rename everywhere', close: 'Close',
    hint: 'Changes the name in the story, the characters, the beats and every scene (who speaks, the action lines, the dialogue and the acting notes), in English and Hindi. Only the whole name changes (SULA, not SULATA). A name written in Hindi letters is a different spelling: rename it too.',
    found: (r) => (r.scenes + r.otherPlaces + r.mentions + r.speakerLines === 0 ? 'This name was not found in the script.' : `Found in ${r.scenes} scene${r.scenes === 1 ? '' : 's'}: ${r.speakerLines} speaking line${r.speakerLines === 1 ? '' : 's'}, ${r.mentions} mention${r.mentions === 1 ? '' : 's'} inside the scenes, and ${r.otherPlaces} in the story, characters and beats.`),
    done: (r) => `✓ Renamed: ${r.scenes} scene${r.scenes === 1 ? '' : 's'} and ${r.otherPlaces} place${r.otherPlaces === 1 ? '' : 's'} in the story, characters and beats.`,
    undo: (a, b) => `↶ Undo the last rename (${a} → ${b})`, askUndo: 'This brings back the whole script exactly as it was before that rename. Anything you changed after the rename is lost. Go ahead?', yesUndo: 'Yes, undo it', no: 'No',
    undone: 'Put back as it was.', working: 'Working…', failed: 'Something went wrong. Please try again.', again: 'Check again first — the names changed.',
  },
  hi: {
    open: '✎ किसी character का नाम बदलो', title: 'पूरी script में character का नाम बदलो', from: 'पुराना नाम', to: 'नया नाम', check: 'जाँचो', go: 'हर जगह बदलो', close: 'बंद करो',
    hint: 'कहानी, characters, beats और हर scene में (कौन बोल रहा है, action की लाइनें, dialogue और acting notes) नाम बदलता है — English और Hindi दोनों में। सिर्फ़ पूरा नाम बदलता है (SULA बदलेगा, SULATA नहीं)। हिंदी अक्षरों में लिखा नाम अलग spelling है: उसे भी बदलो।',
    found: (r) => (r.scenes + r.otherPlaces + r.mentions + r.speakerLines === 0 ? 'यह नाम script में नहीं मिला।' : `${r.scenes} scene में मिला: ${r.speakerLines} बोलने की लाइनें, scenes के अंदर ${r.mentions} ज़िक्र, और कहानी, characters व beats में ${r.otherPlaces}।`),
    done: (r) => `✓ बदल दिया: ${r.scenes} scene और कहानी, characters व beats में ${r.otherPlaces} जगह।`,
    undo: (a, b) => `↶ आखिरी नाम-बदलाव वापस लो (${a} → ${b})`, askUndo: 'इससे पूरी script ठीक वैसी हो जाएगी जैसी उस बदलाव से पहले थी। उसके बाद आपने जो भी बदला है वह चला जाएगा। आगे बढ़ें?', yesUndo: 'हाँ, वापस लो', no: 'नहीं',
    undone: 'जैसा था वैसा वापस रख दिया।', working: 'हो रहा है…', failed: 'कुछ गड़बड़ हुई। फिर कोशिश करो।', again: 'पहले फिर से जाँचो — नाम बदल गए हैं।',
  },
  or: {
    open: '✎ ଚରିତ୍ରର ନାମ ବଦଳାଅ', title: 'ପୂରା ସ୍କ୍ରିପ୍ଟରେ ଚରିତ୍ରର ନାମ ବଦଳାଅ', from: 'ପୁରୁଣା ନାମ', to: 'ନୂଆ ନାମ', check: 'ଯାଞ୍ଚ କର', go: 'ସବୁଠି ବଦଳାଅ', close: 'ବନ୍ଦ',
    hint: 'କାହାଣୀ, ଚରିତ୍ର, ବିଟ୍ ଓ ପ୍ରତ୍ୟେକ ସିନ୍‌ରେ (କିଏ କହୁଛି, ଆକ୍ସନ୍ ଲାଇନ୍, ଡାଇଲଗ୍ ଓ ଆକ୍ଟିଂ ନୋଟ୍) ନାମ ବଦଳେ — ଇଂରାଜୀ ଓ ହିନ୍ଦୀ ଦୁଇଟିରେ। କେବଳ ପୂରା ନାମ ବଦଳେ (SULA, SULATA ନୁହେଁ)। ହିନ୍ଦୀ ଅକ୍ଷରରେ ଲେଖା ନାମ ଅଲଗା ବନାନ: ତାହାକୁ ମଧ୍ୟ ବଦଳାଅ।',
    found: (r) => (r.scenes + r.otherPlaces + r.mentions + r.speakerLines === 0 ? 'ଏହି ନାମ ସ୍କ୍ରିପ୍ଟରେ ମିଳିଲା ନାହିଁ।' : `${r.scenes}ଟି ସିନ୍‌ରେ ମିଳିଲା: ${r.speakerLines} କହିବା ଧାଡ଼ି, ସିନ୍ ଭିତରେ ${r.mentions} ଉଲ୍ଲେଖ, ଏବଂ କାହାଣୀ, ଚରିତ୍ର ଓ ବିଟ୍‌ରେ ${r.otherPlaces}।`),
    done: (r) => `✓ ବଦଳିଗଲା: ${r.scenes}ଟି ସିନ୍ ଏବଂ କାହାଣୀ, ଚରିତ୍ର ଓ ବିଟ୍‌ରେ ${r.otherPlaces} ଜାଗା।`,
    undo: (a, b) => `↶ ଶେଷ ନାମ-ବଦଳ ଫେରାଅ (${a} → ${b})`, askUndo: 'ଏହା ପୂରା ସ୍କ୍ରିପ୍ଟକୁ ସେହି ବଦଳ ପୂର୍ବ ଅବସ୍ଥାକୁ ଫେରାଇବ। ତା’ପରେ ଆପଣ ଯାହା ବଦଳାଇଛନ୍ତି ତାହା ଚାଲିଯିବ। ଆଗକୁ ବଢ଼ିବା?', yesUndo: 'ହଁ, ଫେରାଅ', no: 'ନା',
    undone: 'ଯେମିତି ଥିଲା ସେମିତି ଫେରାଗଲା।', working: 'ହେଉଛି…', failed: 'କିଛି ଭୁଲ ହେଲା। ପୁଣି ଚେଷ୍ଟା କର।', again: 'ପ୍ରଥମେ ପୁଣି ଯାଞ୍ଚ କର — ନାମ ବଦଳିଛି।',
  },
}

const call = async (url, method = 'GET', body) => {
  try {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { ok: response.ok, data: await response.json().catch(() => ({})) }
  } catch {
    return { ok: false, data: {} }
  }
}

export default function AiMovieRename({ backendUrl, projectId, language = 'en', names = [], disabled = false, onChanged }) {
  const L = TEXT[language === 'or' ? 'or' : language === 'hi' ? 'hi' : 'en']
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [checked, setChecked] = useState(null) // { from, to, result } — what the last check found
  const [undo, setUndo] = useState({ canUndo: false })
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const base = `${backendUrl}/api/ai-movie/projects/${projectId}/rename-character`

  const loadUndo = useCallback(async () => { const r = await call(base); if (r.ok) setUndo(r.data) }, [base])
  useEffect(() => { loadUndo() }, [loadUndo])

  const sameAsChecked = checked && checked.from === from.trim() && checked.to === to.trim()
  async function run(fn) {
    if (busy) return null
    setBusy(true); setError(''); setNote('')
    const r = await fn()
    setBusy(false)
    if (!r.ok) { setError(r.data.error || L.failed); return null }
    return r.data
  }
  const check = async () => { const d = await run(() => call(base, 'POST', { from, to, preview: true })); if (d) setChecked({ from: from.trim(), to: to.trim(), result: d }) }
  const rename = async () => {
    if (!sameAsChecked) { setNote(L.again); return }
    const d = await run(() => call(base, 'POST', { from, to }))
    if (d) { setNote(L.done(d)); setChecked(null); await loadUndo(); await onChanged?.() }
  }
  const doUndo = async () => {
    setAsking(false)
    const d = await run(() => call(`${base}/undo`, 'POST', {}))
    if (d) { setNote(L.undone); setChecked(null); await loadUndo(); await onChanged?.() }
  }

  return (
    <div className="ai-scene-tools ai-rename" aria-label={L.title}>
      {!open ? (
        <button type="button" className="cancel-button ai-rename-open" disabled={disabled} onClick={() => setOpen(true)}>{L.open}</button>
      ) : (
        <div className="feedback-form">
          <p><strong>{L.title}</strong></p>
          <p className="ai-movie-scene-duration">{L.hint}</p>
          <label className="ai-scene-field">{L.from}
            <input type="text" list="ai-rename-names" value={from} maxLength={60} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <datalist id="ai-rename-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
          <label className="ai-scene-field">{L.to}
            <input type="text" value={to} maxLength={60} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="button" className="cancel-button" disabled={busy || disabled || !from.trim() || !to.trim()} onClick={check}>{busy ? L.working : L.check}</button>{' '}
          <button type="button" className="choose-button" disabled={busy || disabled || !sameAsChecked || (checked.result.scenes + checked.result.otherPlaces + checked.result.mentions + checked.result.speakerLines === 0)} onClick={rename}>{L.go}</button>{' '}
          <button type="button" className="cancel-button" disabled={busy} onClick={() => { setOpen(false); setNote(''); setError('') }}>{L.close}</button>
          {sameAsChecked && <p className="ai-movie-scene-duration" role="status">{L.found(checked.result)}</p>}
        </div>
      )}
      {undo.canUndo && !asking && <button type="button" className="cancel-button ai-rename-undo" disabled={busy || disabled} onClick={() => setAsking(true)}>{L.undo(undo.from, undo.to)}</button>}
      {asking && (
        <div className="feedback-form" role="alertdialog">
          <p>{L.askUndo}</p>
          <button type="button" className="choose-button" disabled={busy} onClick={doUndo}>{L.yesUndo}</button>{' '}
          <button type="button" className="cancel-button" disabled={busy} onClick={() => setAsking(false)}>{L.no}</button>
        </div>
      )}
      {note && <p className="ai-movie-scene-duration" role="status">{note}</p>}
      {error && <p className="feedback-note" role="alert">{error}</p>}
    </div>
  )
}
