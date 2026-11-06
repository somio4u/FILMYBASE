import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ScriptDoctorPanel.css'

// ONE screen for a script doctor's report: 1. choose the file  2. see the changes it asks for  3. press one button  4. watch each change being made.
// Every change is shown with where it stands (waiting · being made, 12 of 61 scenes · done · needs you); how long it has run and when it last moved are shown;
// the whole thing survives a reload (the server keeps it). Nothing is changed until the person presses "Make the changes".
const EN = {
  title: '📄 Script Doctor report', close: 'Close', draftLine: (t) => `Changes are made in this draft: ${t}`,
  step1: '1. Choose the report file (PDF or Word)', choose: 'Choose the report file', reading: 'Reading the report…', readingLine: (a, b, t) => `Reading part ${a} of ${b} · ${t}`,
  readFail: 'The report could not be read completely:', none: 'No changes were found in this report.',
  step2: (n) => `2. ${n} change${n === 1 ? '' : 's'} found — tick the ones to make`, all: 'Tick all', clear: 'Clear',
  kinds: { structure: 'Story and structure', scene: 'Scene fixes', global: 'Whole-script changes', risk: 'Risks', keep: 'Protected — will not be changed' },
  sceneWord: (s) => `scene${s.length === 1 ? '' : 's'} ${s.join(', ')}`, wholeScript: 'every scene', needsYouTag: 'needs your decision',
  how: 'How it works: each scene is rewritten once, with all the changes that belong to it. Lines the report says to protect are kept. Each scene can be undone. A change about the story itself that has no scene number is NOT made automatically — it is listed for you at the end.',
  make: (n) => `▶ Make the changes${n ? ` (${n} ticked)` : ' (all)'}`, askMake: (t) => `Make the changes in “${t}”? Each scene is rewritten by the AI. It can take a long time for a long film; you can leave this screen and come back — it carries on. Every scene can be undone.`, yes: 'Yes, make them', no: 'No',
  starting: 'Starting…', applying: (d, n, t) => `Making the changes — scene ${d} of ${n} · ${t}`, rightNow: 'Right now', lastMoved: (t) => `last moved ${t} ago`, stuck: '⚠ Nothing has moved for over 10 minutes. It may be stuck — press Stop, then Make the changes again (finished scenes are skipped).',
  carryOn: '▶ Carry on with the rest (finished scenes are skipped)', stop: 'Stop after this scene', stopping: 'Stopping…', stopped: 'Stopped. Press “Make the changes” to carry on with the rest (finished scenes are skipped).',
  states: { waiting: 'waiting', working: 'being made', done: 'done', manual: 'needs you' }, scenesOf: (d, t) => `${d} of ${t} scenes`,
  endedLine: (c, u, f) => `Stopped with problems: ${c} scene${c === 1 ? '' : 's'} rewritten, ${u} already fine, ${f} could not be done.`,
  doneLine: (c, u, f) => `✓ Finished: ${c} scene${c === 1 ? '' : 's'} rewritten, ${u} already fine${f ? `, ${f} could not be done` : ''}.`, failed: (n) => `${n} scene${n === 1 ? '' : 's'} could not be done:`, again: 'Press “Make the changes” again to try those scenes once more (the finished ones are skipped).',
  undoAll: '↶ Undo everything the report changed', askUndo: 'Put back every scene the report changed, exactly as it was? Anything you edited in those scenes since is kept only if it cannot be undone safely.', yesUndo: 'Yes, undo all', undoneLine: (n, f) => `Put back ${n} scene${n === 1 ? '' : 's'}${f ? `; ${f} could not be put back (edited since)` : ''}.`,
  needsYou: (n) => `Needs you (${n}) — not made automatically`, send: 'Send to Adu', sent: '✓ sent to Adu', startOver: 'Use another report', offline: 'Could not reach the server. Try again in a minute.', wrong: 'Something went wrong.',
  counts: (p, a, c) => `${p} protected line${p === 1 ? '' : 's'} are kept in every rewrite.`,
}
const HI = {
  ...EN,
  title: '📄 Script Doctor की report', close: 'बंद करो', draftLine: (t) => `बदलाव इस draft में होंगे: ${t}`,
  step1: '1. Report की file चुनो (PDF या Word)', choose: 'Report की file चुनो', reading: 'Report पढ़ रहा हूँ…', readingLine: (a, b, t) => `${b} में से हिस्सा ${a} पढ़ रहा हूँ · ${t}`,
  readFail: 'Report पूरी नहीं पढ़ी जा सकी:', none: 'इस report में कोई बदलाव नहीं मिला।',
  step2: (n) => `2. ${n} बदलाव मिले — जो करने हैं उन पर टिक करो`, all: 'सब टिक करो', clear: 'हटाओ',
  kinds: { structure: 'कहानी और ढाँचा', scene: 'Scene के सुधार', global: 'पूरी script पर बदलाव', risk: 'जोखिम', keep: 'सुरक्षित — बदला नहीं जाएगा' },
  sceneWord: (s) => `scene ${s.join(', ')}`, wholeScript: 'हर scene', needsYouTag: 'आपका फ़ैसला चाहिए',
  how: 'यह ऐसे चलता है: हर scene एक बार दोबारा लिखा जाता है, उसके सारे बदलावों के साथ। जिन लाइनों को report ने बचाने को कहा है वे बची रहती हैं। हर scene का Undo है। कहानी के बारे में जो बदलाव बिना scene नंबर के हैं, वे अपने-आप नहीं होते — वे आख़िर में आपके लिए अलग सूची में दिखते हैं।',
  make: (n) => `▶ बदलाव लगाओ${n ? ` (${n} टिक किए)` : ' (सारे)'}`, askMake: (t) => `“${t}” में बदलाव लगाएँ? हर scene AI से दोबारा लिखा जाएगा। लंबी film में बहुत समय लग सकता है; आप यह screen छोड़कर लौट सकते हो — वह चलता रहता है। हर scene का Undo है।`, yes: 'हाँ, लगाओ', no: 'नहीं',
  starting: 'शुरू हो रहा है…', applying: (d, n, t) => `बदलाव लग रहे हैं — ${n} में से scene ${d} · ${t}`, rightNow: 'अभी', lastMoved: (t) => `${t} पहले आख़िरी बार हिला`, stuck: '⚠ 10 मिनट से ज़्यादा से कुछ नहीं हिला। शायद अटक गया है — Stop दबाओ, फिर “बदलाव लगाओ” दोबारा (पूरे हो चुके scenes छोड़ दिए जाते हैं)।',
  carryOn: '▶ बाकी पर आगे बढ़ो (पूरे हो चुके scenes छोड़ दिए जाते हैं)', stop: 'इस scene के बाद रोको', stopping: 'रुक रहा है…', stopped: 'रुक गया। बाकी के लिए “बदलाव लगाओ” दबाओ (पूरे हो चुके scenes छोड़ दिए जाते हैं)।',
  states: { waiting: 'इंतज़ार में', working: 'लग रहा है', done: 'हो गया', manual: 'आपका काम' }, scenesOf: (d, t) => `${t} में से ${d} scenes`,
  endedLine: (c, u, f) => `समस्याओं के साथ रुका: ${c} scene दोबारा लिखे गए, ${u} पहले से ठीक थे, ${f} नहीं हो पाए।`,
  doneLine: (c, u, f) => `✓ पूरा हुआ: ${c} scene दोबारा लिखे गए, ${u} पहले से ठीक थे${f ? `, ${f} नहीं हो पाए` : ''}।`, failed: (n) => `${n} scene नहीं हो पाए:`, again: 'उन scenes को एक बार और आज़माने के लिए “बदलाव लगाओ” फिर दबाओ (पूरे हो चुके छोड़ दिए जाते हैं)।',
  undoAll: '↶ report ने जो बदला वह सब वापस लो', askUndo: 'report ने जो भी scenes बदले हैं, उन सबको ठीक पहले जैसा कर दें? उसके बाद आपने जो बदला है वह सिर्फ़ तभी बचेगा जब उसका Undo सुरक्षित न हो।', yesUndo: 'हाँ, सब वापस लो', undoneLine: (n, f) => `${n} scene वापस रखे${f ? `; ${f} वापस नहीं हो पाए (बाद में बदले गए)` : ''}।`,
  needsYou: (n) => `आपका काम (${n}) — अपने-आप नहीं किए गए`, send: 'Adu को भेजो', sent: '✓ Adu को भेजा', startOver: 'दूसरी report लो', offline: 'Server तक पहुँच नहीं हुई। एक मिनट बाद फिर कोशिश करो।', wrong: 'कुछ गड़बड़ हुई।',
  counts: (p) => `${p} बचाई जाने वाली लाइनें हर rewrite में सुरक्षित रहती हैं।`,
}
const OR = { ...EN, title: '📄 Script Doctor ରିପୋର୍ଟ', close: 'ବନ୍ଦ', choose: 'ରିପୋର୍ଟ ଫାଇଲ୍ ବାଛ', make: (n) => `▶ ବଦଳ ଲଗାଅ${n ? ` (${n} ଟିକ୍)` : ' (ସବୁ)'}`, yes: 'ହଁ, ଲଗାଅ', no: 'ନା', stop: 'ଏହି ସିନ୍ ପରେ ଅଟକାଅ', startOver: 'ଆଉ ଏକ ରିପୋର୍ଟ' }
const TEXT = { en: EN, hi: HI, or: OR }

const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s` }
const call = async (url, method = 'GET', body, isForm = false) => {
  try {
    const response = await fetch(url, { method, ...(isForm ? { body } : { headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }) })
    return { ok: response.ok, data: await response.json().catch(() => ({})) }
  } catch { return { ok: false, data: {}, offline: true } }
}
const ICON = { waiting: '○', working: '⏳', done: '✓', manual: '👉' }

export default function ScriptDoctorPanel({ backendUrl, projectId, draft, language = 'en', onClose, onChanged, onSendToChat }) {
  const L = TEXT[language] ?? EN
  const api = `${backendUrl}/api/ai-movie/assistant/${projectId}`
  const [readId, setReadId] = useState(null)
  const [read, setRead] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState(null) // null = not touched yet: every change that can be made is ticked
  const [asking, setAsking] = useState(false)
  const [askUndo, setAskUndo] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [sent, setSent] = useState([])
  const [, setTick] = useState(0)
  const fileRef = useRef(null)
  const alive = useRef(true)
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged
  const lastDone = useRef('')

  const load = useCallback(async (id) => {
    const rid = id ?? readId
    if (!rid) return null
    const r = await call(`${api}/report/${rid}`)
    if (!alive.current || !r.ok) return null
    setRead(r.data)
    const mark = `${r.data.apply?.jobId}:${r.data.apply?.done}:${r.data.apply?.status}`
    if (r.data.apply?.jobId && mark !== lastDone.current) { lastDone.current = mark; changedRef.current?.() } // the screenplay on screen follows the work
    return r.data
  }, [api, readId])
  useEffect(() => {
    alive.current = true
    ;(async () => { const r = await call(`${api}/report`); if (alive.current) { setReadId(r.data?.readId ?? null); setLoaded(true) } })()
    return () => { alive.current = false }
  }, [api])
  useEffect(() => { if (readId) load(readId) }, [readId, load])

  const reading = read && read.partsDone < read.parts && read.job?.status === 'running'
  const applying = read?.apply?.status === 'running'
  useEffect(() => {
    if (!reading && !applying) return undefined
    const poll = setInterval(() => load(), 3000)
    const tick = setInterval(() => setTick((n) => n + 1), 1000)
    return () => { clearInterval(poll); clearInterval(tick) }
  }, [reading, applying, load])

  async function upload(file) {
    if (!file) return
    setBusy('upload'); setError(''); setNote('')
    const form = new FormData(); form.append('file', file); form.append('language', language)
    const r = await call(`${api}/report`, 'POST', form, true)
    setBusy('')
    if (fileRef.current) fileRef.current.value = ''
    if (!r.ok) { setError(r.offline ? L.offline : (r.data.error || L.wrong)); return }
    setSelected(null); setSent([]); setReadId(r.data.readId); await load(r.data.readId)
  }

  const items = read?.items ?? []
  const doable = items.filter((i) => i.kind !== 'keep')
  const keeps = items.filter((i) => i.kind === 'keep')
  const ticked = selected ?? doable.map((i) => i.id)
  const toggle = (id) => setSelected(ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id])

  async function make(resume = false) {
    setAsking(false); setBusy('apply'); setError(''); setNote('')
    const r = await call(`${api}/report/${readId}/apply`, 'POST', { draftId: draft?.id, ids: ticked, resume })
    setBusy('')
    if (!r.ok) { setError(r.offline ? L.offline : (r.data.error || L.wrong)); return }
    await load()
  }
  async function stop() { await call(`${api}/report/${readId}/apply/stop`, 'POST', {}); await load() }
  async function undoAll() {
    setAskUndo(false); setBusy('undo'); setError('')
    const r = await call(`${api}/report/${readId}/apply/undo`, 'POST', {})
    setBusy('')
    if (!r.ok) { setError(r.data.error || L.wrong); return }
    setNote(L.undoneLine(r.data.undone, r.data.failed?.length ?? 0)); await load(); changedRef.current?.()
  }

  const a = read?.apply
  const startedMs = a?.startedAt ? a.startedAt : null
  const movedMs = read?.lastMovedAt ?? a?.startedAt ?? null
  const handled = a ? a.done + (a.failed?.length ?? 0) : 0
  const quiet = a?.status === 'running' && movedMs ? Date.now() - movedMs : 0
  const hasPlan = Boolean(read?.plan)
  const finished = a && a.status !== 'running'
  const progress = read?.progress ?? []

  const body = (
    <div className="sd-panel" role="dialog" aria-label={L.title}>
      <div className="sd-head">
        <h2>{L.title}</h2>
        <button type="button" className="sd-x" onClick={onClose} aria-label={L.close}>×</button>
      </div>
      {draft && <p className="sd-fine">{L.draftLine(draft.title || (language === 'hi' ? 'यही खुला draft' : 'the draft that is open now'))}</p>}
      {error && <p className="sd-error" role="alert">{error}</p>}
      {note && <p className="sd-ok" role="status">{note}</p>}

      {/* 1 — choose the file */}
      {(!read || (!reading && items.length === 0)) && (
        <section className="sd-step">
          <h3>{L.step1}</h3>
          <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,application/pdf" style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0])} />
          <button type="button" className="sd-btn primary" disabled={busy === 'upload' || !loaded} onClick={() => fileRef.current?.click()}>{busy === 'upload' ? L.reading : L.choose}</button>
          {read && !reading && items.length === 0 && read.partsDone >= read.parts && <p className="sd-fine">{L.none}</p>}
        </section>
      )}

      {/* reading */}
      {read && reading && (
        <section className="sd-step">
          <div className="sd-bar" role="progressbar" aria-valuenow={read.partsDone} aria-valuemax={read.parts}><div style={{ width: `${Math.round((read.partsDone / Math.max(1, read.parts)) * 100)}%` }} /></div>
          <p className="sd-live">⏳ {L.readingLine(read.partsDone + 1 > read.parts ? read.parts : read.partsDone + 1, read.parts, clock(Date.now() - (read.job?.startedAt ?? new Date(read.createdAt).getTime())))}</p>
        </section>
      )}
      {read && !reading && read.partsDone < read.parts && <p className="sd-error" role="alert">{L.readFail} {read.job?.failed?.[0]?.error || read.job?.error || ''}</p>}

      {/* 2 — the list */}
      {read && items.length > 0 && !hasPlan && (
        <section className="sd-step">
          <h3>{L.step2(doable.length)}</h3>
          <p className="sd-fine">{L.how}</p>
          <p className="sd-fine">{L.counts(keeps.length)}</p>
          <p>
            <button type="button" className="sd-btn" onClick={() => setSelected(doable.map((i) => i.id))}>{L.all}</button>{' '}
            <button type="button" className="sd-btn" onClick={() => setSelected([])}>{L.clear}</button>
          </p>
          {read.groups.filter((g) => g.kind !== 'keep').map((g) => (
            <div key={g.kind} className="sd-group">
              <h4>{L.kinds[g.kind]} ({g.items.length})</h4>
              <ul>
                {g.items.map((i) => (
                  <li key={i.id} className={`sd-item is-${i.severity}`}>
                    <label>
                      <input type="checkbox" checked={ticked.includes(i.id)} onChange={() => toggle(i.id)} /> <strong>{i.title}</strong>
                      <small> · {i.kind === 'global' ? L.wholeScript : i.scenes?.length ? L.sceneWord(i.scenes) : L.needsYouTag}</small>
                    </label>
                    <p className="sd-text">{i.action}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {!asking ? (
            <button type="button" className="sd-btn primary big" disabled={Boolean(busy) || !draft?.id || ticked.length === 0} onClick={() => setAsking(true)}>{busy === 'apply' ? L.starting : L.make(selected ? ticked.length : 0)}</button>
          ) : (
            <div className="sd-ask" role="alertdialog">
              <p>{L.askMake(draft?.title ?? 'this draft')}</p>
              <button type="button" className="sd-btn primary" onClick={() => make(false)}>{L.yes}</button>{' '}
              <button type="button" className="sd-btn" onClick={() => setAsking(false)}>{L.no}</button>
            </div>
          )}
          <p><button type="button" className="sd-link" onClick={() => { setRead(null); setReadId(null) }}>{L.startOver}</button></p>
        </section>
      )}

      {/* 4 — the changes being made / made */}
      {read && hasPlan && (
        <section className="sd-step">
          {a?.status === 'running' && (
            <>
              <div className="sd-bar" role="progressbar" aria-valuenow={handled} aria-valuemax={a.total}><div style={{ width: `${Math.round((handled / Math.max(1, a.total)) * 100)}%` }} /></div>
              <p className="sd-live">⏳ {L.applying(Math.min(handled + 1, a.total), a.total, startedMs ? clock(Date.now() - startedMs) : '…')}</p>
              <p className="sd-fine"><strong>{L.rightNow}:</strong> {a.step}{movedMs ? ` · ${L.lastMoved(clock(Date.now() - movedMs))}` : ''}</p>
              {quiet > 10 * 60 * 1000 && <p className="sd-error" role="alert">{L.stuck}</p>}
              <button type="button" className="sd-btn" disabled={a.stopRequested} onClick={stop}>{a.stopRequested ? L.stopping : L.stop}</button>
            </>
          )}
          {finished && a.status === 'stopped' && <p className="sd-fine">{L.stopped}</p>}
          {finished && a.status === 'done' && (a.failed?.length ?? 0) === 0 && <p className="sd-ok">{L.doneLine(read.counts.changed, read.counts.unchanged, 0)}</p>}
          {finished && (a.status === 'error' || (a.failed?.length ?? 0) > 0) && a.status !== 'stopped' && <p className="sd-error" role="alert">⚠ {L.endedLine(read.counts.changed, read.counts.unchanged, a.failed?.length ?? 0)}</p>}
          <ul className="sd-progress">
            {progress.filter((p) => p.state !== 'manual').map((p) => (
              <li key={p.id} className={`is-${p.state}`}>
                <span className="sd-mark" aria-hidden="true">{ICON[p.state]}</span> <strong>{p.title}</strong>
                <small> · {L.states[p.state]} · {L.scenesOf(p.done, p.total)}</small>
                {p.total > 0 && <div className="sd-bar thin"><div style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} /></div>}
              </li>
            ))}
          </ul>
          {finished && (a.failed?.length ?? 0) > 0 && (() => {
            // the same reason for several scenes is said once: "Scene 1, 2, 3: <reason>"
            const groups = []
            for (const f of a.failed) { const g = groups.find((x) => x.error === f.error); if (g) g.labels.push(f.label); else groups.push({ error: f.error, labels: [f.label] }) }
            return (
              <div className="sd-error" role="alert">
                <p>{L.failed(a.failed.length)}</p>
                <ul>{groups.slice(0, 5).map((g) => <li key={g.error}>{g.labels.slice(0, 12).join(', ')}{g.labels.length > 12 ? ` … (+${g.labels.length - 12})` : ''}: {g.error}</li>)}</ul>
                <p>{L.again}</p>
              </div>
            )
          })()}
          {finished && (
            <p>
              {(a.status !== 'done' || (a.failed?.length ?? 0) > 0) && <><button type="button" className="sd-btn primary" disabled={Boolean(busy)} onClick={() => make(true)}>{busy === 'apply' ? L.starting : L.carryOn}</button>{' '}</>}
              {read.counts.changed > 0 && !askUndo && <button type="button" className="sd-btn" disabled={Boolean(busy)} onClick={() => setAskUndo(true)}>{L.undoAll}</button>}
            </p>
          )}
          {askUndo && (
            <div className="sd-ask" role="alertdialog">
              <p>{L.askUndo}</p>
              <button type="button" className="sd-btn primary" onClick={undoAll}>{L.yesUndo}</button>{' '}
              <button type="button" className="sd-btn" onClick={() => setAskUndo(false)}>{L.no}</button>
            </div>
          )}
          {(read.plan?.manual?.length ?? 0) > 0 && (
            <div className="sd-manual">
              <h4>{L.needsYou(read.plan.manual.length)}</h4>
              <ul>
                {read.plan.manual.map((m) => (
                  <li key={m.id}>
                    <strong>{m.title}</strong> <small>· {m.why}</small>
                    <p className="sd-text">{m.action}</p>
                    {sent.includes(m.id) ? <small>{L.sent}</small> : <button type="button" className="sd-link" onClick={() => { onSendToChat?.(m.action); setSent((s) => [...s, m.id]) }}>{L.send}</button>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p><button type="button" className="sd-link" onClick={() => { setRead(null); setReadId(null); setSelected(null) }}>{L.startOver}</button></p>
        </section>
      )}
    </div>
  )
  return createPortal(<div className="sd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>{body}</div>, document.body)
}
