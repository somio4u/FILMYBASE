import { useCallback, useEffect, useState } from 'react'

// AI Movie → the tools of the scene on screen for the SCENES themselves: add a scene before / after, move it up or down, remove it, and undo the last removal.
// A new scene starts blank (no AI, no cost); writing it is a separate step. Removing asks first, and "Undo" puts the last removed scene back where it was.
const TEXT = {
  en: {
    undoChange: (l) => `↶ Undo: ${l}`, redoChange: (l) => `↷ Redo: ${l}`, undoneNote: 'Put back as it was.', redoneNote: 'Done again.',
    title: 'Scenes', addBefore: '+ Add a scene before', addAfter: '+ Add a scene after', up: '↑ Move up', down: '↓ Move down', remove: '🗑 Remove this scene', undo: '↶ Undo the last removal',
    formTitle: (where) => `New scene ${where}`, before: 'before this scene', after: 'after this scene', intExt: 'INT / EXT', place: 'Place (for example TEMPLE)', time: 'Time', what: 'What happens (optional — it becomes the first line)',
    create: 'Add the blank scene', cancel: 'Cancel', note: 'The new scene is blank: write it with “Edit this scene”, “Ask AI to change it” or “Write dialogue”.',
    askRemove: (n) => `Remove scene ${n}? You can bring it back with “Undo the last removal”.`, yesRemove: 'Yes, remove it', working: 'Working…', failed: 'Something went wrong. Please try again.',
    added: 'Added. It is blank — write it next.', moved: 'Moved.', removed: 'Removed. “Undo the last removal” brings it back.', restored: 'Put back.',
  },
  hi: {
    undoChange: (l) => `↶ वापस लो: ${l}`, redoChange: (l) => `↷ फिर से लगाओ: ${l}`, undoneNote: 'जैसा था वैसा वापस रख दिया।', redoneNote: 'फिर से लगा दिया।',
    title: 'Scenes', addBefore: '+ इससे पहले scene जोड़ो', addAfter: '+ इसके बाद scene जोड़ो', up: '↑ ऊपर करो', down: '↓ नीचे करो', remove: '🗑 यह scene हटाओ', undo: '↶ आखिरी हटाया वापस लाओ',
    formTitle: (where) => `नया scene ${where}`, before: 'इस scene से पहले', after: 'इस scene के बाद', intExt: 'INT / EXT', place: 'जगह (जैसे TEMPLE)', time: 'समय', what: 'क्या होता है (ज़रूरी नहीं — यही पहली लाइन बनेगी)',
    create: 'खाली scene जोड़ो', cancel: 'रद्द करो', note: 'नया scene खाली है: उसे “Edit this scene”, “Ask AI to change it” या “Write dialogue” से लिखो।',
    askRemove: (n) => `Scene ${n} हटाएँ? “आखिरी हटाया वापस लाओ” से इसे वापस ला सकते हो।`, yesRemove: 'हाँ, हटाओ', working: 'हो रहा है…', failed: 'कुछ गड़बड़ हुई। फिर कोशिश करो।',
    added: 'जुड़ गया। यह खाली है — अब इसे लिखो।', moved: 'खिसका दिया।', removed: 'हट गया। “आखिरी हटाया वापस लाओ” से वापस आएगा।', restored: 'वापस रख दिया।',
  },
  or: {
    undoChange: (l) => `↶ ଫେରାଅ: ${l}`, redoChange: (l) => `↷ ପୁଣି ଲଗାଅ: ${l}`, undoneNote: 'ଯେମିତି ଥିଲା ସେମିତି ଫେରାଗଲା।', redoneNote: 'ପୁଣି ଲାଗିଗଲା।',
    title: 'ସିନ୍', addBefore: '+ ଏହା ପୂର୍ବରୁ ସିନ୍ ଯୋଡ଼', addAfter: '+ ଏହା ପରେ ସିନ୍ ଯୋଡ଼', up: '↑ ଉପରକୁ', down: '↓ ତଳକୁ', remove: '🗑 ଏହି ସିନ୍ ହଟାଅ', undo: '↶ ଶେଷ ହଟାଇଥିବା ଫେରାଅ',
    formTitle: (where) => `ନୂଆ ସିନ୍ ${where}`, before: 'ଏହି ସିନ୍ ପୂର୍ବରୁ', after: 'ଏହି ସିନ୍ ପରେ', intExt: 'INT / EXT', place: 'ସ୍ଥାନ (ଯେପରି TEMPLE)', time: 'ସମୟ', what: 'କ’ଣ ହୁଏ (ଇଚ୍ଛାଧୀନ — ତାହା ପ୍ରଥମ ଧାଡ଼ି ହେବ)',
    create: 'ଖାଲି ସିନ୍ ଯୋଡ଼', cancel: 'ବାତିଲ୍', note: 'ନୂଆ ସିନ୍ ଖାଲି: ଏହାକୁ “Edit this scene”, “Ask AI to change it” କିମ୍ବା “Write dialogue” ଦ୍ୱାରା ଲେଖ।',
    askRemove: (n) => `ସିନ୍ ${n} ହଟାଇବା? “ଶେଷ ହଟାଇଥିବା ଫେରାଅ” ଦ୍ୱାରା ଫେରାଇପାରିବ।`, yesRemove: 'ହଁ, ହଟାଅ', working: 'ହେଉଛି…', failed: 'କିଛି ଭୁଲ ହେଲା। ପୁଣି ଚେଷ୍ଟା କର।',
    added: 'ଯୋଡ଼ାଗଲା। ଏହା ଖାଲି — ଏବେ ଲେଖ।', moved: 'ଘୁଞ୍ଚାଗଲା।', removed: 'ହଟିଗଲା। “ଶେଷ ହଟାଇଥିବା ଫେରାଅ” ଦ୍ୱାରା ଫେରିବ।', restored: 'ଫେରାଗଲା।',
  },
}

const call = async (url, method, body) => {
  try {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { ok: response.ok, data: await response.json().catch(() => ({})) }
  } catch {
    return { ok: false, data: {} }
  }
}

export default function AiMovieSceneTools({ backendUrl, projectId, beatIndex, sceneIndex, sceneCount, sceneNumber, language = 'en', canUndo = false, disabled = false, onChanged }) {
  const L = TEXT[language === 'or' ? 'or' : language === 'hi' ? 'hi' : 'en']
  const [form, setForm] = useState(null) // { after: scene index to insert after (-1 = start), where }
  const [fields, setFields] = useState({ intExt: 'INT', location: '', timeOfDay: 'DAY', what: '' })
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const base = `${backendUrl}/api/ai-movie/stages/screenplay`
  // Undo / Redo of the last change to any scene (an edit, an AI rewrite, a dialogue, add / move / remove): what the next Undo and the next Redo would be
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const loadHistory = useCallback(async () => { const r = await call(`${backendUrl}/api/ai-movie/projects/${projectId}/scene-history`); if (r.ok) setHistory(r.data) }, [backendUrl, projectId])
  useEffect(() => { loadHistory() }, [loadHistory, beatIndex, sceneIndex, sceneCount])
  useEffect(() => { const timer = setInterval(loadHistory, 6000); return () => clearInterval(timer) }, [loadHistory])
  const undoRedo = (direction) => run(() => call(`${backendUrl}/api/ai-movie/projects/${projectId}/scene-history/${direction}`, 'POST', {}), direction === 'undo' ? L.undoneNote : L.redoneNote, (d) => Math.min(sceneIndex, Math.max(0, (d.sceneCount ?? sceneCount) - 1))).then(loadHistory)

  async function run(fn, doneText, pick) {
    if (busy) return
    setBusy(true); setError(''); setNote('')
    const r = await fn()
    setBusy(false)
    if (!r.ok) { setError(r.data.error || L.failed); return }
    setNote(doneText)
    await onChanged?.({ beatIndex: r.data.beatIndex ?? beatIndex, sceneIndex: pick ? pick(r.data) : r.data.sceneIndex })
  }

  const open = (after, where) => { setForm({ after, where }); setAsking(false); setNote(''); setError('') }
  const create = () => run(() => call(`${base}/beats/${beatIndex}/scenes`, 'POST', { projectId, afterIndex: form.after, ...fields }), L.added).then(() => { setForm(null); setFields({ intExt: 'INT', location: '', timeOfDay: 'DAY', what: '' }) })
  const off = disabled || busy

  return (
    <div className="ai-scene-tools" aria-label={L.title}>
      <p className="script-panel-title">{L.title}</p>
      {!form && !asking && (
        <div className="ai-scene-tools-grid">
          <button type="button" className="cancel-button" disabled={off} onClick={() => open(sceneIndex - 1, L.before)}>{L.addBefore}</button>
          <button type="button" className="cancel-button" disabled={off} onClick={() => open(sceneIndex, L.after)}>{L.addAfter}</button>
          <button type="button" className="cancel-button" disabled={off || sceneIndex === 0} onClick={() => run(() => call(`${base}/beats/${beatIndex}/scenes/${sceneIndex}/move`, 'POST', { projectId, direction: 'up' }), L.moved)}>{L.up}</button>
          <button type="button" className="cancel-button" disabled={off || sceneIndex >= sceneCount - 1} onClick={() => run(() => call(`${base}/beats/${beatIndex}/scenes/${sceneIndex}/move`, 'POST', { projectId, direction: 'down' }), L.moved)}>{L.down}</button>
          <button type="button" className="cancel-button" disabled={off || sceneCount <= 1} onClick={() => { setAsking(true); setNote(''); setError('') }}>{L.remove}</button>
          {canUndo && <button type="button" className="cancel-button" disabled={off} onClick={() => run(() => call(`${base}/scenes/restore`, 'POST', { projectId }), L.restored)}>{L.undo}</button>}
          {history.canUndo && <button type="button" className="cancel-button" disabled={off} onClick={() => undoRedo('undo')}>{L.undoChange(history.undoLabel)}</button>}
          {history.canRedo && <button type="button" className="cancel-button" disabled={off} onClick={() => undoRedo('redo')}>{L.redoChange(history.redoLabel)}</button>}
        </div>
      )}
      {asking && (
        <div className="feedback-form" role="alertdialog">
          <p>{L.askRemove(sceneNumber)}</p>
          <button type="button" className="choose-button" disabled={busy} onClick={() => run(() => call(`${base}/beats/${beatIndex}/scenes/${sceneIndex}`, 'DELETE', { projectId }), L.removed, (d) => Math.min(d.sceneIndex, sceneCount - 2)).then(() => setAsking(false))}>{busy ? L.working : L.yesRemove}</button>{' '}
          <button type="button" className="cancel-button" disabled={busy} onClick={() => setAsking(false)}>{L.cancel}</button>
        </div>
      )}
      {form && (
        <div className="feedback-form">
          <p><strong>{L.formTitle(form.where)}</strong></p>
          <label className="ai-scene-field">{L.intExt}
            <select value={fields.intExt} onChange={(e) => setFields({ ...fields, intExt: e.target.value })}><option>INT</option><option>EXT</option><option>INT/EXT</option></select>
          </label>
          <label className="ai-scene-field">{L.place}
            <input type="text" value={fields.location} maxLength={80} onChange={(e) => setFields({ ...fields, location: e.target.value })} />
          </label>
          <label className="ai-scene-field">{L.time}
            <input type="text" value={fields.timeOfDay} maxLength={20} onChange={(e) => setFields({ ...fields, timeOfDay: e.target.value })} />
          </label>
          <label className="ai-scene-field">{L.what}
            <textarea className="feedback-textarea" value={fields.what} maxLength={400} onChange={(e) => setFields({ ...fields, what: e.target.value })} />
          </label>
          <p className="ai-movie-scene-duration">{L.note}</p>
          <button type="button" className="choose-button" disabled={busy || !fields.location.trim()} onClick={create}>{busy ? L.working : L.create}</button>{' '}
          <button type="button" className="cancel-button" disabled={busy} onClick={() => setForm(null)}>{L.cancel}</button>
        </div>
      )}
      {note && <p className="ai-movie-scene-duration" role="status">{note}</p>}
      {error && <p className="feedback-note" role="alert">{error}</p>}
    </div>
  )
}
