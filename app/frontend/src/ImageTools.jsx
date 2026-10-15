// Two helpers of the Image Studio:
//   ImportPictures  — pictures made in ANOTHER tool, saved under the names from the "image commands" PDF, come back here and are
//                     connected by name to the right character, environment, props sheet or shot (waiting for review).
//   PropCombiner    — small props share ONE picture (a numbered grid) instead of one paid picture each.
import { useCallback, useEffect, useRef, useState } from 'react'

async function call(url, method = 'GET', body) {
  try {
    const response = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ok: response.ok, data: await response.json().catch(() => ({})) }
  } catch {
    return { ok: false, data: { error: 'Could not reach the server.' } }
  }
}
const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`

export function ImportPictures({ api, projectId, onImported }) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [approve, setApprove] = useState(false)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')

  async function upload(event) {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (files.length === 0) return
    setBusy(true); setError(''); setReport(null)
    try {
      const body = new FormData()
      for (const file of files) body.append('files', file, file.name)
      body.append('autoApprove', approve ? 'true' : 'false')
      const response = await fetch(`${api}/${projectId}/import-pictures`, { method: 'POST', body })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not import the pictures.')
      setReport(data)
      onImported?.()
    } catch (e) {
      setError(e.message)
    }
    setBusy(false)
  }

  return (
    <section className="studio-card" aria-label="Import pictures made elsewhere">
      <h3>⬆ Import pictures I made elsewhere</h3>
      <p className="dossier-fine-print">Made the pictures in another tool? Save each one under the name written in the commands PDF (for example CHAR001_Rohan.png or SC001_SH003.png), then choose them all here — or one .zip. Each picture is connected by its name to the right character, environment, props sheet or shot and waits for your review. Importing costs nothing.</p>
      <div className="pipe-toolbar">
        <input ref={inputRef} type="file" multiple accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,.zip,application/zip" onChange={upload} style={{ display: 'none' }} />
        <button type="button" className="dossier-small-button" disabled={busy} onClick={() => inputRef.current?.click()}>{busy ? 'Importing…' : 'Choose pictures or a .zip'}</button>
        <label className="studio-field" style={{ flexDirection: 'row', gap: 6 }}><input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} disabled={busy} /> Approve them straight away</label>
      </div>
      {error && <p className="dossier-error" role="alert">{error}</p>}
      {report && (
        <div role="status">
          <p className="dossier-message"><strong>{report.imported.length}</strong> picture{report.imported.length === 1 ? '' : 's'} connected{report.imported.length > 0 && !approve ? ' — now waiting for your review in each tab' : ''}{report.skipped.length > 0 ? `, ${report.skipped.length} could not be used.` : '.'}</p>
          {report.imported.length > 0 && (
            <ul className="dossier-fine-print">{report.imported.map((r, i) => <li key={`${r.file}-${i}`}>✅ {r.file} → <strong>{r.target}</strong> (version {r.version}{r.approved ? ', approved' : ''})</li>)}</ul>
          )}
          {report.skipped.length > 0 && (
            <ul className="dossier-error">{report.skipped.map((r, i) => <li key={`${r.file}-${i}`}>⚠️ {r.file}: {r.reason}</li>)}</ul>
          )}
        </div>
      )}
    </section>
  )
}

export function PropCombiner({ api, projectId }) {
  const [perImage, setPerImage] = useState(6)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/props/combine-preview?perImage=${perImage}`)
    if (r.ok) setPreview(r.data)
  }, [api, projectId, perImage])
  useEffect(() => { load() }, [load])

  async function combine() {
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/props/combine`, 'POST', { perImage })
    setBusy(false)
    if (!r.ok) { setMessage({ tone: 'bad', text: r.data.error || 'Could not combine the props.' }); return }
    setMessage({ tone: 'good', text: `${r.data.combined} props now share ${r.data.groups.length} picture${r.data.groups.length === 1 ? '' : 's'} (${r.data.picturesSaved} fewer to pay for). Make each props sheet like any other picture.` })
    load()
  }
  async function split() {
    if (!window.confirm('Go back to one picture per prop? (Props sheets that were already made are kept.)')) return
    setBusy(true); setMessage(null)
    const r = await call(`${api}/${projectId}/props/split`, 'POST', {})
    setBusy(false)
    if (!r.ok) { setMessage({ tone: 'bad', text: r.data.error || 'Could not split.' }); return }
    setMessage({ tone: 'good', text: r.data.split > 0 ? `${r.data.split} sheet${r.data.split === 1 ? '' : 's'} split back into single props.${r.data.keptBecauseMade?.length ? ` Kept because they were already made: ${r.data.keptBecauseMade.join(', ')}.` : ''}` : (r.data.keptBecauseMade?.length ? `Nothing split: ${r.data.keptBecauseMade.join(', ')} already made.` : 'There was nothing to split.') })
    load()
  }

  if (!preview) return null
  return (
    <section className="studio-card" aria-label="Combine small props">
      <h3>🧩 Combine small props into shared pictures</h3>
      <p className="dossier-fine-print">Small props (a bamboo, a mug, a camera, a TV…) do not each need their own paid picture. They are put together in ONE image, laid out in a numbered grid; every shot then names the prop by its position on the sheet (“position 2: the mug”). Props that already have a picture are left alone.</p>
      <div className="pipe-toolbar">
        <label className="studio-field">Props per picture (2–9)<input type="number" min="2" max="9" value={perImage} onChange={(e) => setPerImage(Math.max(2, Math.min(9, Number(e.target.value) || 6)))} disabled={busy} /></label>
        <button type="button" className="dossier-small-button" disabled={busy || preview.groups === 0} onClick={combine}>{busy ? 'Working…' : `Combine ${preview.combined} props into ${preview.groups} picture${preview.groups === 1 ? '' : 's'}`}</button>
        {preview.existing.length > 0 && <button type="button" className="dossier-small-button" disabled={busy} onClick={split}>Split back into single props</button>}
      </div>
      <p className="dossier-fine-print">
        {preview.groups > 0 ? `${preview.props} props without a picture → ${preview.groups} picture${preview.groups === 1 ? '' : 's'}, saving about ${usd(preview.savedUsd)}.` : 'No props waiting to be combined.'}
        {preview.existing.length > 0 ? ` Sheets now: ${preview.existing.map((g) => `${g.code} (${g.members.map((m) => `${m.position} ${m.name}`).join(', ')})`).join(' · ')}.` : ''}
      </p>
      {message && <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  )
}

// Every character is INDIAN unless you say otherwise (the cast rule). This shows it, and lets you name another origin.
export function OriginControl({ api, projectId, asset, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(asset.origin ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(next) {
    setBusy(true); setError('')
    const r = await call(`${api}/${projectId}/assets/${asset.dbId}/origin`, 'PUT', { origin: next })
    setBusy(false)
    if (!r.ok) { setError(r.data.error || 'Could not save.'); return }
    setEditing(false); setValue(r.data.origin ?? '')
    onChanged?.()
  }
  return (
    <div className="dossier-fine-print" style={{ margin: '4px 0' }}>
      {!editing ? (
        <>
          <span>🌏 Origin: <strong>{asset.origin ? `${asset.origin} (not Indian)` : 'Indian (default)'}</strong></span>{' '}
          <button type="button" className="dossier-small-button" onClick={() => { setValue(asset.origin ?? ''); setEditing(true) }}>Change</button>
        </>
      ) : (
        <span>
          <input value={value} maxLength={80} placeholder="e.g. British, Japanese — empty = Indian" onChange={(e) => setValue(e.target.value)} disabled={busy} aria-label={`Origin of ${asset.name}`} />{' '}
          <button type="button" className="dossier-small-button" disabled={busy} onClick={() => save(value)}>Save</button>{' '}
          <button type="button" className="dossier-small-button" disabled={busy} onClick={() => save('')}>Make Indian</button>{' '}
          <button type="button" className="dossier-small-button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        </span>
      )}
      {error && <span className="dossier-error"> {error}</span>}
    </div>
  )
}
