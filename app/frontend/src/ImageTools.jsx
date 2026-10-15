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

// REFERENCE IMAGES: the real logo / brand / title artwork the film must show. Added once; the app attaches it (with "copy it
// exactly") to every picture whose text mentions it. Adu also reads the screenplay and suggests which ones are needed.
const KIND_LABELS = { logo: 'Logo', title: 'Title / caption', brand: 'Brand / product', other: 'Other' }

export function ReferenceImages({ api, backendUrl, projectId }) {
  const fileRef = useRef(null)
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null) // { label, kind, keywords } while adding
  const [busy, setBusy] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [message, setMessage] = useState(null)
  const autoRan = useRef(false)

  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/references`)
    if (r.ok) setData(r.data)
    return r.ok ? r.data : null
  }, [api, projectId])

  const detect = useCallback(async () => {
    setDetecting(true); setMessage(null)
    const r = await call(`${api}/${projectId}/references/detect`, 'POST', {})
    setDetecting(false)
    if (r.ok) setData(r.data)
    else setMessage({ tone: 'bad', text: r.data.error || 'Could not read the screenplay for brands.' })
  }, [api, projectId])

  useEffect(() => {
    load().then((d) => {
      // the first time, Adu reads the screenplay by himself and suggests the brands and titles that need a real picture
      if (d && !d.checked && !autoRan.current) { autoRan.current = true; detect() }
    })
  }, [load, detect])

  async function save(event) {
    event.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!form.label.trim()) { setMessage({ tone: 'bad', text: 'Give it a name, for example “Tarang Plus logo”.' }); return }
    if (!file) { setMessage({ tone: 'bad', text: 'Choose the picture first.' }); return }
    setBusy(true); setMessage(null)
    const body = new FormData()
    body.append('file', file); body.append('label', form.label); body.append('kind', form.kind); body.append('keywords', form.keywords)
    try {
      const response = await fetch(`${api}/${projectId}/references`, { method: 'POST', body })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Could not save the reference.')
      setForm(null)
      setMessage({ tone: 'good', text: `“${form.label}” is saved. From now on it goes along automatically with every picture whose text mentions it — the commands were updated.` })
      await load()
    } catch (e) {
      setMessage({ tone: 'bad', text: e.message })
    }
    setBusy(false)
  }

  async function remove(ref) {
    if (!window.confirm(`Remove “${ref.label}”? Pictures already made are kept.`)) return
    setBusy(true)
    const response = await fetch(`${api}/${projectId}/references/${ref.id}`, { method: 'DELETE' })
    setBusy(false)
    if (response.ok) { setMessage({ tone: 'good', text: `“${ref.label}” removed.` }); load() }
  }

  if (!data) return null
  const addNew = (preset = {}) => setForm({ label: preset.name ?? '', kind: preset.kind ?? 'logo', keywords: (preset.keywords ?? []).join(', ') })
  return (
    <section className="studio-card" aria-label="Reference images">
      <h3>🏷 Reference images — logos, brands, titles</h3>
      <p className="dossier-fine-print">An image model cannot draw a real logo from its name — it makes one up. Add the real picture here once (for example the Tarang Plus logo). It is attached automatically, with “copy it exactly”, to every picture whose text mentions that name, and the commands PDF tells you which one to attach when you make pictures elsewhere.</p>

      {data.references.length > 0 && (
        <ul className="is-grid" style={{ listStyle: 'none', padding: 0 }}>
          {data.references.map((r) => (
            <li key={r.id} className="is-card">
              <header className="is-card-head"><strong>{r.code} · {r.label}</strong><span className="dossier-fine-print">{KIND_LABELS[r.kind] ?? r.kind}</span></header>
              <img src={`${backendUrl}${r.mediaUrl}`} alt={r.label} style={{ maxWidth: '100%', maxHeight: 140, objectFit: 'contain', background: '#fff' }} />
              <p className="dossier-fine-print">Also written as: {r.keywords.length ? r.keywords.join(', ') : '— (only the name above)'}</p>
              <button type="button" className="dossier-small-button" disabled={busy} onClick={() => remove(r)}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      {data.suggestions.length > 0 && (
        <div role="status">
          <p className="dossier-message"><strong>Adu found {data.suggestions.length} name{data.suggestions.length === 1 ? '' : 's'} in the screenplay that need a real picture:</strong></p>
          <ul className="dossier-fine-print">
            {data.suggestions.map((s) => (
              <li key={s.name}><strong>{s.name}</strong> ({KIND_LABELS[s.kind] ?? s.kind}){s.where ? ` — ${s.where}` : ''} <button type="button" className="dossier-small-button" disabled={busy} onClick={() => addNew(s)}>Add the picture</button></li>
            ))}
          </ul>
        </div>
      )}
      {detecting && <p className="floating-agent-stage-line"><span className="floating-agent-spinner" aria-hidden="true" /><span>Adu is reading the screenplay for brands and titles…</span></p>}
      {!detecting && data.checked && data.suggestions.length === 0 && data.references.length === 0 && <p className="dossier-fine-print">Adu found no brands or titles in the screenplay. You can still add one yourself.</p>}

      {form && (
        <form onSubmit={save} className="pipe-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
          <label className="studio-field">Name<input value={form.label} maxLength={80} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Tarang Plus logo" disabled={busy} /></label>
          <label className="studio-field">Type
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} disabled={busy}>
              {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="studio-field">Also written as (commas)<input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="e.g. Tarang, Tarang TV" disabled={busy} /></label>
          <label className="studio-field">The picture<input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" disabled={busy} /></label>
          <button type="submit" className="dossier-small-button" disabled={busy}>{busy ? 'Saving…' : 'Save reference'}</button>
          <button type="button" className="dossier-small-button" disabled={busy} onClick={() => setForm(null)}>Cancel</button>
        </form>
      )}
      {!form && (
        <div className="pipe-toolbar">
          <button type="button" className="dossier-small-button" disabled={busy} onClick={() => addNew()}>➕ Add a reference image</button>
          <button type="button" className="dossier-small-button" disabled={busy || detecting} onClick={detect}>{detecting ? 'Looking…' : '🔎 Find brands & titles in the screenplay'}</button>
        </div>
      )}
      {message && <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  )
}
