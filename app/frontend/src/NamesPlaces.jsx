import { useCallback, useEffect, useState } from 'react'

// "Names & places" inside the Smart Scheduler: say that names are the same place / the same person.
// The scheduler then counts them as one; "Screenplay में भी बदलो" also changes the name in the screenplay itself.
async function call(backendUrl, path, options) {
  const response = await fetch(`${backendUrl}${path}`, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.')
  return data
}
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export default function NamesPlaces({ backendUrl, sceneListId, onChanged }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState('location') // 'location' | 'artist'
  const [data, setData] = useState(null)
  const [picked, setPicked] = useState([])
  const [keep, setKeep] = useState('')
  const [inScript, setInScript] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [undo, setUndo] = useState(null) // the last place rename that can be taken back

  const base = `/api/smart-scheduler/${sceneListId}/names`
  const load = useCallback(async () => {
    try {
      setData(await call(backendUrl, base))
      setUndo((await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-location/latest`)).latest)
    } catch (e) { setMessage(e.message) }
  }, [backendUrl, base, sceneListId])
  useEffect(() => { if (open && !data) load() }, [open, data, load])
  useEffect(() => { setPicked([]); setKeep(''); setMessage('') }, [kind])

  const list = (kind === 'location' ? data?.locations : data?.artists) ?? []
  const suggestions = data?.suggestions?.[kind] ?? []
  const info = (name) => list.find((x) => x.name === name)
  const mostUsed = (names) => [...names].sort((a, b) => (info(b)?.scenes.length ?? 0) - (info(a)?.scenes.length ?? 0) || a.length - b.length)[0]
  const noun = kind === 'location' ? 'place' : 'character'
  const togglePick = (name) => { const next = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name]; setPicked(next); if (!next.includes(keep)) setKeep(next.length ? mostUsed(next) : '') }

  // the screenplay itself: first count what would change, ask, then change
  async function changeScreenplay(names, to) {
    if (kind === 'location') {
      const body = { names, to }
      const pv = await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-location`, post({ ...body, preview: true }))
      if (pv.scenes === 0) return 'The screenplay already uses this name everywhere.'
      if (!window.confirm(`${pv.scenes} scene heading(s) will change to "${to}" (INT/EXT of each scene stays). You can undo this. Go ahead?`)) return 'The screenplay was left as it is.'
      const done = await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-location`, post(body))
      return `${done.scenes} scene heading(s) now say "${to}".`
    }
    const others = names.filter((n) => n !== to)
    const counts = []
    for (const from of others) counts.push([from, await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-character`, post({ from, to, preview: true }))])
    const total = counts.reduce((n, [, c]) => n + c.scenes, 0)
    if (total === 0) return 'The screenplay already uses this name everywhere.'
    if (!window.confirm(`In the screenplay ${counts.map(([f, c]) => `${f} → ${to}: ${c.scenes} scene(s)`).join(', ')} will change. Each changed scene is saved as a new version (Undo works in the screenplay). Go ahead?`)) return 'The screenplay was left as it is.'
    for (const [from] of counts) await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-character`, post({ from, to }))
    return `The screenplay now says ${to} in ${total} scene(s).`
  }

  async function merge(names, canonical, alsoScript) {
    if (busy) return
    setBusy(true); setMessage('')
    try {
      await call(backendUrl, `${base}/merge`, post({ kind, names, canonical }))
      let note = `Merged into ${canonical.toUpperCase()}.`
      if (alsoScript) note += ` ${await changeScreenplay(names, canonical.toUpperCase())}`
      setMessage(note); setPicked([]); setKeep('')
      await load(); onChanged?.()
    } catch (e) { setMessage(e.message) }
    setBusy(false)
  }
  async function act(path, body, note) {
    setBusy(true); setMessage('')
    try { await call(backendUrl, `${base}/${path}`, post({ kind, ...body })); if (note) setMessage(note); await load(); onChanged?.() } catch (e) { setMessage(e.message) }
    setBusy(false)
  }
  async function undoRename() {
    setBusy(true); setMessage('')
    try {
      const r = await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-location/${undo.id}/undo`, { method: 'POST' })
      setMessage(`${r.restored} scene heading(s) are back as they were.`)
      await load(); onChanged?.()
    } catch (e) { setMessage(e.message) }
    setBusy(false)
  }

  const merged = list.filter((x) => x.mergedInto)
  const finals = [...new Set(merged.map((x) => x.mergedInto))]

  return (
    <section className="ss-card">
      <h3 className="ss-names-head" onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>{open ? '▾' : '▸'} Names &amp; places <small>same place or same person written two ways? Make it one.</small></h3>
      {open && (
        <>
          <div className="ss-tabs">
            <button type="button" className={kind === 'location' ? 'is-on' : ''} onClick={() => setKind('location')}>📍 Places</button>
            <button type="button" className={kind === 'artist' ? 'is-on' : ''} onClick={() => setKind('artist')}>🎭 Characters</button>
          </div>
          {!data && !message && <p className="ss-muted">Reading the names…</p>}
          {message && <p className="ss-note" role="status">{message}</p>}
          {data && (
            <>
              <h4>Suggested — look the same</h4>
              {suggestions.length === 0 && <p className="ss-muted">No more suggestions.</p>}
              {suggestions.map((group) => {
                const names = [...group].sort((a, b) => (info(b)?.scenes.length ?? 0) - (info(a)?.scenes.length ?? 0))
                return (
                  <div className="ss-sugg" key={group.join('|')}>
                    <div className="ss-sugg-names">{names.map((n) => <span className="ss-nm" key={n}>{n} <small>{info(n)?.scenes.length ?? 0} scenes</small></span>)}</div>
                    <div className="ss-sugg-act">
                      <button type="button" disabled={busy} onClick={() => merge(names, names[0], inScript)}>Merge into {names[0]}</button>
                      <button type="button" className="ss-ghost" disabled={busy} onClick={() => act('dismiss', { names }, 'Okay, these stay separate.')}>Not the same</button>
                    </div>
                  </div>
                )
              })}

              <h4>Choose yourself — all {kind === 'location' ? 'places' : 'characters'} and their scenes</h4>
              <div className="ss-pick">
                {list.map((x) => (
                  <label key={x.name} className={`ss-pick-row${x.mergedInto ? ' is-merged' : ''}`}>
                    <input type="checkbox" disabled={Boolean(x.mergedInto)} checked={picked.includes(x.name)} onChange={() => togglePick(x.name)} />
                    <span className="ss-name">{x.name}{x.mergedInto ? ` → ${x.mergedInto}` : ''}<small>{x.scenes.length} scenes: {x.scenes.slice(0, 14).join(', ')}{x.scenes.length > 14 ? '…' : ''}</small></span>
                  </label>
                ))}
              </div>
              {picked.length >= 2 && (
                <div className="ss-merge-form">
                  <label>Keep this {noun} name
                    <input list="ss-keep-names" value={keep} onChange={(e) => setKeep(e.target.value)} />
                    <datalist id="ss-keep-names">{picked.map((n) => <option key={n} value={n} />)}</datalist>
                  </label>
                  <button type="button" disabled={busy || !keep.trim()} onClick={() => merge(picked, keep.trim(), inScript)}>Merge {picked.length} names</button>
                </div>
              )}
              <label className="ss-check"><input type="checkbox" checked={inScript} onChange={(e) => setInScript(e.target.checked)} /> Screenplay में भी बदलो <small>(you will see how many scenes change and can confirm; places can be undone here, characters with the screenplay's Undo)</small></label>

              {finals.length > 0 && (
                <>
                  <h4>Already merged</h4>
                  {finals.map((f) => (
                    <div className="ss-sugg" key={f}>
                      <div className="ss-sugg-names"><b>{f}</b> ← {merged.filter((x) => x.mergedInto === f).map((x) => <span className="ss-nm" key={x.name}>{x.name}</span>)}</div>
                      <div className="ss-sugg-act"><button type="button" className="ss-ghost" disabled={busy} onClick={() => act('split', { name: f }, 'Separated again.')}>Separate</button></div>
                    </div>
                  ))}
                </>
              )}
              {undo && <p className="ss-muted">Last place change in the screenplay: {undo.scenes} heading(s) → "{undo.to}". <button type="button" className="ss-ghost" disabled={busy} onClick={undoRename}>↶ Undo</button></p>}
            </>
          )}
        </>
      )}
    </section>
  )
}
