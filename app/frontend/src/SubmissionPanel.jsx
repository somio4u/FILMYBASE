// Uploading design files for a task, and submitting them as an exact version.
// Used by the designer's own screen and by the reviewer's Dossier (the
// reviewer can do the same on any task while one person plays every role).
//
//   apiBase  - address of the task, e.g. ".../api/designer/tasks/5"
//   mediaUrl - turns a media id into a viewing address
import { useState } from 'react'

const FILE_ROLE_TEXT = { clean: 'Clean image', sheet: 'Contact / review sheet', reference: 'Reference' }
const VERSION_STATE_TEXT = {
  draft: 'draft (not sent yet)',
  submitted: 'submitted, waiting for review',
  approved: 'approved',
  changes_requested: 'changes requested',
  superseded: 'replaced by a newer version',
}
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf'

function FileThumb({ file, mediaUrl }) {
  if (file.mime.startsWith('image/')) {
    return <img className="submission-thumb" src={mediaUrl(file.mediaId)} alt={file.viewName || file.originalName || 'Uploaded design'} loading="lazy" />
  }
  return <a className="submission-thumb submission-thumb-file" href={mediaUrl(file.mediaId)} target="_blank" rel="noreferrer">PDF</a>
}

function sizeText(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export default function SubmissionPanel({ task, apiBase, mediaUrl, onChanged }) {
  const deliverables = task.brief.deliverables
  const [viewName, setViewName] = useState(deliverables[0] ?? '')
  const [fileRole, setFileRole] = useState('clean')
  const [progress, setProgress] = useState([]) // [{ name, status, error }]
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const draft = task.submissions.find((s) => s.state === 'draft') ?? null
  const history = task.submissions.filter((s) => s.state !== 'draft')
  const canUpload = ['open', 'claimed', 'changes_requested'].includes(task.state)
  const hasClean = draft?.files.some((f) => f.fileRole === 'clean') ?? false
  const notStored = draft?.files.filter((f) => f.mediaStatus !== 'stored').length ?? 0

  async function uploadFiles(fileList) {
    const files = [...fileList]
    if (files.length === 0) return
    setError(null)
    setProgress(files.map((f) => ({ name: f.name, status: 'waiting' })))
    // One at a time: big files, and the server keeps one draft.
    for (let i = 0; i < files.length; i++) {
      setProgress((p) => p.map((x, j) => (j === i ? { ...x, status: 'uploading' } : x)))
      const body = new FormData()
      body.append('fileRole', fileRole)
      if (viewName) body.append('viewName', viewName)
      body.append('file', files[i])
      let result
      try {
        const response = await fetch(`${apiBase}/uploads`, { method: 'POST', body })
        const data = await response.json().catch(() => ({}))
        result = response.ok ? { status: data.duplicate ? 'already there' : 'done' } : { status: 'failed', error: data.error || 'Upload failed.' }
      } catch {
        result = { status: 'failed', error: 'Could not reach the server.' }
      }
      setProgress((p) => p.map((x, j) => (j === i ? { ...x, ...result } : x)))
    }
    await onChanged()
  }

  async function call(path, method, body) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) setError(data.error || 'That did not work.')
      await onChanged()
      return response.ok
    } catch {
      setError('Could not reach the server.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    const n = draft.versionNo
    if (!window.confirm(`Submit version ${n}? Once sent you cannot change it. To fix something later you will make a new version.`)) return
    if (await call('/submit', 'POST', { expectedRevision: task.revision, note })) setNote('')
  }

  return (
    <section className="dossier-section submission-panel">
      <h4>Your design files</h4>

      {task.state === 'submitted' && <p className="dossier-message" role="status">Version {history.filter((h) => h.state === 'submitted').slice(-1)[0]?.versionNo} is with the reviewer. You can add more once they reply.</p>}
      {task.state === 'changes_requested' && <p className="dossier-message" role="status">Changes were requested. Upload a new version below.</p>}
      {task.state === 'approved' && <p className="dossier-ok" role="status">Approved.</p>}

      {canUpload && (
        <>
          <div className="dossier-controls-row">
            <label className="dossier-field">
              These files show
              <select value={viewName} onChange={(e) => setViewName(e.target.value)}>
                {deliverables.map((d) => <option key={d} value={d}>{d}</option>)}
                <option value="">Something else</option>
              </select>
            </label>
            <label className="dossier-field">
              File type
              <select value={fileRole} onChange={(e) => setFileRole(e.target.value)}>
                {Object.entries(FILE_ROLE_TEXT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
          <label className="submission-drop">
            <span>Choose images or a PDF (PNG, JPG, WebP, GIF, PDF; up to 100 MB each)</span>
            <input type="file" accept={ACCEPT} multiple onChange={(e) => { uploadFiles(e.target.files); e.target.value = '' }} />
          </label>
          {progress.length > 0 && (
            <ul className="submission-progress" aria-live="polite">
              {progress.map((p, i) => (
                <li key={i} className={p.status === 'failed' ? 'dossier-bad' : ''}>
                  {p.name}: {p.status}{p.error ? ` — ${p.error}` : ''}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {draft && (
        <div className="submission-version">
          <h5>Version {draft.versionNo} — {VERSION_STATE_TEXT.draft}</h5>
          <ul className="submission-files">
            {draft.files.map((f) => (
              <li key={f.id}>
                <FileThumb file={f} mediaUrl={mediaUrl} />
                <div>
                  <strong>{f.viewName || '(no label)'}</strong>
                  <div className="dossier-fine-print">{FILE_ROLE_TEXT[f.fileRole]} · {sizeText(f.bytes)}{f.mediaStatus !== 'stored' ? ' · still saving to storage…' : ''}</div>
                  <div className="submission-file-actions">
                    <select
                      aria-label="File type"
                      value={f.fileRole}
                      disabled={busy}
                      onChange={(e) => call(`/uploads/${f.id}`, 'PATCH', { fileRole: e.target.value })}
                    >
                      {Object.entries(FILE_ROLE_TEXT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <button type="button" className="dossier-small-button" disabled={busy} onClick={() => call(`/uploads/${f.id}`, 'DELETE')}>Remove</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <label className="dossier-field">
            Note for the reviewer (optional)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
          </label>
          <div className="dossier-save-row">
            <button type="button" className="choose-button" disabled={busy || !hasClean || notStored > 0} onClick={submit}>
              Submit version {draft.versionNo}
            </button>
            {!hasClean && <span className="dossier-fine-print">Add at least one clean image to submit.</span>}
            {notStored > 0 && <span className="dossier-fine-print">Wait until every file has finished saving.</span>}
          </div>
        </div>
      )}
      {error && <p className="dossier-bad" role="alert">{error}</p>}

      {history.length > 0 && (
        <div className="submission-history">
          <h5>Earlier versions</h5>
          {history.map((v) => (
            <details key={v.id} open={v === history[history.length - 1]}>
              <summary>Version {v.versionNo} — {VERSION_STATE_TEXT[v.state] ?? v.state}{v.submittedAt ? ` · ${new Date(v.submittedAt).toLocaleString()}` : ''}</summary>
              {v.note && <p className="dossier-fine-print">Note: {v.note}</p>}
              <ul className="submission-files">
                {v.files.map((f) => (
                  <li key={f.id}>
                    <FileThumb file={f} mediaUrl={mediaUrl} />
                    <div>
                      <strong>{f.viewName || '(no label)'}</strong>
                      <div className="dossier-fine-print">{FILE_ROLE_TEXT[f.fileRole]} · {sizeText(f.bytes)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}
