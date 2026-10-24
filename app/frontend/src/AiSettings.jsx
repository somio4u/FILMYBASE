import { useCallback, useEffect, useRef, useState } from 'react'
import './SmartScheduler.css'

// Settings (admin only): which Google Vertex key the whole app uses. Paste or upload the JSON key, TEST it (a real tiny AI call), then save —
// the app switches at once, no deploy, nothing to change on the server. The key is never shown again after saving.
// What the screen says for each way the server can answer (or not answer) — never a blank error
function whyNot(status, data) {
  if (data?.error) return data.error
  if (status === 401) return 'You are logged out. Log in again as admin and retry.'
  if (status === 403) return 'Only the admin login can change these settings.'
  if (status === 404) return 'The server does not have this page yet — it is probably still updating after a deploy. Wait two minutes, refresh the page and try again.'
  if (status === 413) return 'That is far too big to be a key file. Use the small .json file downloaded from Google Cloud.'
  if (status === 429) return 'Too many tries in a short time. Wait a minute and try again.'
  if (status >= 500) return `The server had a problem (code ${status}). Wait a minute and try again.`
  return `The server answered with an unexpected reply (code ${status}).`
}
async function call(backendUrl, path, options) {
  let response
  try { response = await fetch(`${backendUrl}${path}`, options) } catch {
    return { ok: false, status: 0, data: { error: 'The server could not be reached. It may be restarting or asleep — wait a minute and try again.' } }
  }
  const data = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, data: response.ok ? data : { ...data, error: whyNot(response.status, data) } }
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '')

// a quick look at what was pasted, so the admin sees which project it belongs to before testing
function peek(text) {
  try {
    const cleaned = String(text).replace(/^\uFEFF/, '').replace(/[“”]/g, '"').trim()
    const j = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1))
    if (j?.project_id && j.client_email && j.private_key) return { projectId: j.project_id, email: j.client_email }
  } catch { /* not valid yet */ }
  return null
}

export default function AiSettings({ backendUrl, onBack }) {
  const [status, setStatus] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [text, setText] = useState('')
  const [location, setLocation] = useState('us-central1')
  const [testing, setTesting] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [result, setResult] = useState(null) // { ok, message, projectId, seconds, forText }
  const [saving, setSaving] = useState(false)
  const [asking, setAsking] = useState('') // '' | 'remove' | 'anyway'
  const [message, setMessage] = useState('')
  const [fileNote, setFileNote] = useState('')
  const fileInput = useRef(null)

  const load = useCallback(async () => {
    try {
      const r = await call(backendUrl, '/api/settings/ai')
      if (!r.ok) throw new Error(r.data.error || 'Could not read the settings.')
      setStatus(r.data); setLocation((cur) => (cur === 'us-central1' && r.data.location ? r.data.location : cur)); setLoadError('')
    } catch (e) { setLoadError(e.message) }
  }, [backendUrl])
  useEffect(() => { load() }, [load])

  // a running clock while Google is being asked, so it is clear the test is alive
  useEffect(() => {
    if (!testing) return undefined
    setSeconds(0)
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [testing])

  const seen = peek(text)
  const tested = result?.ok && result.forText === text + '|' + location

  async function readFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setResult(null); setMessage('')
    if (file.size > 100000) { setFileNote(`“${file.name}” is ${Math.round(file.size / 1024)} KB — far too big for a key file (they are about 2 KB).`); return }
    try {
      const content = await file.text()
      setText(content)
      setFileNote(content.trim() ? `Read “${file.name}” (${content.length} characters).` : `“${file.name}” is empty.`)
    } catch { setFileNote(`Could not read “${file.name}”. Try pasting its text instead.`) }
  }

  async function test() {
    setTesting(true); setResult(null); setMessage('')
    try {
      const r = await call(backendUrl, '/api/settings/ai/test', json('POST', { key: text, location }))
      if (!r.ok) setResult({ ok: false, message: r.data.error, steps: [{ key: 'format', ok: false }] })
      else setResult({ ...r.data, forText: text + '|' + location })
    } catch { setResult({ ok: false, message: 'Something unexpected went wrong in this page. Refresh it and try again.' }) }
    setTesting(false)
  }

  async function save(saveAnyway = false) {
    setSaving(true); setAsking(''); setMessage('')
    try {
      const r = await call(backendUrl, '/api/settings/ai', json('PUT', { key: text, location, saveAnyway }))
      if (!r.ok) { setResult({ ok: false, message: r.data.error }); setSaving(false); return }
      setStatus(r.data); setText(''); setResult(null)
      setMessage(`Saved. The whole app now uses project ${r.data.activeProject}.`)
    } catch { setMessage('The server could not be reached. Nothing was saved — try again in a minute.') }
    setSaving(false)
  }

  async function removeSaved() {
    setAsking(''); setMessage('')
    const r = await call(backendUrl, '/api/settings/ai', { method: 'DELETE' })
    if (r.ok) { setStatus(r.data); setMessage("The saved key was removed. The app uses the server's own key again.") } else setMessage(r.data.error || 'Could not remove it.')
  }

  const using = !status ? '' : status.source === 'saved' ? `the key saved here — project ${status.activeProject} (${status.location}), saved by ${status.saved?.savedBy ?? 'an admin'} on ${when(status.saved?.savedAt)}`
    : status.source === 'server' ? `the server's own key — project ${status.activeProject} (${status.location})`
    : status.source === 'apikey' ? 'the plain Gemini key kept on the server (no Google Vertex key)'
    : status.source === 'saved-unreadable' ? 'NO WORKING KEY — the saved key cannot be read'
    : 'no AI key at all'

  return (
    <div className="ss-page">
      <div className="ss-top">
        <button type="button" className="ss-back" onClick={onBack}>← Back</button>
        <h1>⚙️ Settings</h1>
      </div>

      <section className="ss-card">
        <h3>AI connection (Google Vertex)</h3>
        <p className="ss-sub">Every AI task in the app (writing, checks, breakdown, pictures, voices, video) runs on one Google key. Put the key here and the whole app switches to it at once — no deploy, nothing to change on the server or in the database.</p>
        {loadError && <p className="ss-error" role="alert">{loadError}</p>}
        {!status && !loadError && <p className="ss-muted">Reading…</p>}
        {status && <p className="ai-using"><b>Using now:</b> {using}</p>}
        {status?.problem && <p className="ss-error" role="alert">{status.problem}</p>}
        {message && <p className="ss-note" role="status">{message}</p>}
        {status?.lock === 'basic' && <p className="ss-muted">Protection of the saved key: basic. For the strongest protection the server needs one extra secret, SETTINGS_ENCRYPTION_KEY (ask for the one-line steps).</p>}

        <h4>Use a different key</h4>
        <div className="ai-form">
          <div className="ai-row">
            <button type="button" className="ss-back" onClick={() => fileInput.current?.click()}>📄 Choose the JSON file</button>
            <input ref={fileInput} type="file" onChange={readFile} hidden />
            <label className="ai-loc">Location <input value={location} onChange={(e) => { setLocation(e.target.value); setResult(null) }} spellCheck={false} /></label>
          </div>
          <label className="ai-paste">…or paste the whole content of the key file
            <textarea rows={5} value={text} onChange={(e) => { setText(e.target.value); setResult(null); setMessage('') }} placeholder={'{ "type": "service_account", "project_id": "…", … }'} spellCheck={false} autoComplete="off" />
          </label>
          {fileNote && <p className="ss-muted">{fileNote}</p>}
          {seen && <p className="ss-muted">This key belongs to project <b>{seen.projectId}</b> ({seen.email}).</p>}
          {text && !seen && <p className="ss-muted">This page cannot preview the text, but that is fine — press “1 · Test this key”: the server reads it more carefully and tells you exactly what is wrong, if anything.</p>}

          <div className="ai-row">
            <button type="button" className="ss-go" disabled={!text.trim() || testing || saving} onClick={test}>{testing ? 'Testing…' : '1 · Test this key'}</button>
            <button type="button" className="ss-go" disabled={!tested || saving || testing} onClick={() => save(false)}>{saving ? 'Saving…' : '2 · Save and use this key'}</button>
          </div>
          {testing && <p className="sync-live">⏳ Asking Google with this key… <b>{seconds}s</b> (usually under 10 seconds, at most 45). A short test question is being sent; nothing is saved yet.</p>}

          {result?.steps && (
            <ul className="ai-steps">
              {[['format', 'The key file was read'], ['signin', 'Google accepts the key (sign-in)'], ['vertex', 'Vertex AI answers a test question'], ['pro', 'The best-quality (Pro) model answers']].map(([k, label]) => {
                const st = result.steps.find((x) => x.key === k)
                const state = !st ? 'skip' : st.warn ? 'warn' : st.ok ? 'ok' : 'bad'
                return <li key={k} className={`ai-step is-${state}`}>{state === 'ok' ? '✓' : state === 'bad' ? '✗' : state === 'warn' ? '⚠' : '○'} {label}{st?.note ? <small> — {st.note}</small> : null}</li>
              })}
            </ul>
          )}
          {result?.ok && <p className="ss-note" role="status">✓ This key works — project {result.projectId} answered in {result.seconds}s. Now press “2 · Save and use this key”.{result.warnings?.length ? ' One warning above: read it before saving.' : ''}</p>}
          {result && !result.ok && (
            <div role="alert">
              <p className="ss-error">✗ {result.message}</p>
              {result.details && <details className="ai-details"><summary>Technical details (send this if you need help)</summary><pre>{`Project: ${result.projectId}\nService account: ${result.clientEmail}\nLocation: ${result.location}\nStopped at: ${result.step}\nGoogle said: ${result.details}`}</pre></details>}
              {result.projectId && asking !== 'anyway' && <button type="button" className="ss-back" onClick={() => setAsking('anyway')}>Save it anyway…</button>}
              {asking === 'anyway' && (
                <p className="sync-ask">Save a key that failed its test? The app would then use it and its AI tasks would fail the same way until it is fixed in Google Cloud.{' '}
                  <button type="button" className="ss-go" onClick={() => save(true)}>Yes, save anyway</button>{' '}
                  <button type="button" className="ss-back" onClick={() => setAsking('')}>Cancel</button></p>
              )}
            </div>
          )}
        </div>

        {status?.saved && (
          <>
            <h4>The key saved here</h4>
            <p className="ss-muted">Project {status.saved.projectId} · {status.saved.clientEmail} · saved by {status.saved.savedBy ?? 'an admin'} on {when(status.saved.savedAt)}. The key itself is never shown again.</p>
            {asking !== 'remove'
              ? <button type="button" className="ss-back" onClick={() => setAsking('remove')}>Remove the saved key (use the server's own key again)</button>
              : <p className="sync-ask">Remove it? The app goes back to the server's own key{status.serverKeyProject ? ` (project ${status.serverKeyProject})` : ' — there is none, so AI tasks would stop until a key is saved here'}.{' '}
                  <button type="button" className="ss-go" onClick={removeSaved}>Yes, remove</button>{' '}
                  <button type="button" className="ss-back" onClick={() => setAsking('')}>Cancel</button></p>}
          </>
        )}
      </section>
    </div>
  )
}
