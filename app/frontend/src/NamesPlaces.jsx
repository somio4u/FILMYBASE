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

export default function NamesPlaces({ backendUrl, sceneListId, onChanged, onSceneList, embedded = false }) {
  const [open, setOpen] = useState(embedded)
  const [kind, setKind] = useState('location') // 'location' | 'artist'
  const [data, setData] = useState(null)
  const [picked, setPicked] = useState([])
  const [keep, setKeep] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [undo, setUndo] = useState(null) // the last place rename that can be taken back

  const base = `/api/smart-scheduler/${sceneListId}/names`
  const load = useCallback(async () => {
    try {
      const d = await call(backendUrl, base)
      setData(d)
      setUndo((await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-location/latest`)).latest)
      return d
    } catch (e) { setMessage(e.message); return null }
  }, [backendUrl, base, sceneListId])
  useEffect(() => {
    if (!open || data) return
    load().then((d) => (d ? applySavedMerges(d) : null)).catch((e) => setMessage(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, data, load])
  useEffect(() => { setPicked([]); setKeep(''); setMessage('') }, [kind])

  const list = (kind === 'location' ? data?.locations : data?.artists) ?? []
  const suggestions = data?.suggestions?.[kind] ?? []
  const info = (name) => list.find((x) => x.name === name)
  const mostUsed = (names) => [...names].sort((a, b) => (info(b)?.scenes.length ?? 0) - (info(a)?.scenes.length ?? 0) || a.length - b.length)[0]
  const noun = kind === 'location' ? 'place' : 'character'
  const togglePick = (name) => { const next = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name]; setPicked(next); if (!next.includes(keep)) setKeep(next.length ? mostUsed(next) : '') }

  // the screenplay itself: every merge is applied to it too (places: the scene headings; characters: names and dialogue). Returns how many scenes changed.
  async function changeScreenplay(which, names, to) {
    if (which === 'location') {
      const done = await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-location`, post({ names: [...names, to], to }))
      if (done.sceneList && done.scenes > 0) onSceneList?.(done.sceneList)
      return done.scenes
    }
    let total = 0
    let latestList = null
    for (const from of names.filter((n) => n !== to)) {
      const pv = await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-character`, post({ from, to, preview: true }))
      if (pv.scenes === 0 && pv.outlineLines === 0) continue
      const done = await call(backendUrl, `/api/scene-lists/${sceneListId}/rename-character`, post({ from, to }))
      total += done.scenes
      latestList = done.sceneList ?? latestList
    }
    if (latestList) onSceneList?.(latestList)
    return total
  }

  async function merge(names, canonical) {
    if (busy) return
    setBusy(true); setMessage('')
    try {
      const to = canonical.toUpperCase()
      await call(backendUrl, `${base}/merge`, post({ kind, names, canonical }))
      const changed = await changeScreenplay(kind, names, to)
      setMessage(`Merged into ${to}. ${changed > 0 ? `The screenplay now says ${to} in ${changed} scene${changed === 1 ? '' : 's'}.` : 'The screenplay already used this name.'}`)
      setPicked([]); setKeep('')
      await load(); onChanged?.()
    } catch (e) { setMessage(e.message) }
    setBusy(false)
  }

  // merges saved earlier but never applied to the screenplay are applied now (safe to repeat: it only changes what still differs)
  async function applySavedMerges(d) {
    let places = 0
    let people = 0
    for (const [which, items] of [['location', d.locations], ['artist', d.artists]]) {
      const groups = new Map()
      for (const x of items) if (x.mergedInto) groups.set(x.mergedInto, [...(groups.get(x.mergedInto) ?? []), x.name])
      for (const [to, names] of groups) { const n = await changeScreenplay(which, names, to); if (which === 'location') places += n; else people += n }
    }
    if (places + people > 0) {
      setMessage(`Your earlier merges are now in the screenplay too: ${places} scene heading${places === 1 ? '' : 's'} and ${people} scene${people === 1 ? '' : 's'} with a character name changed.`)
      await load(); onChanged?.()
    }
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
      if (r.sceneList) onSceneList?.(r.sceneList)
      setMessage(`${r.restored} scene heading(s) are back as they were.`)
      await load(); onChanged?.()
    } catch (e) { setMessage(e.message) }
    setBusy(false)
  }

  const merged = list.filter((x) => x.mergedInto)
  const finals = [...new Set(merged.map((x) => x.mergedInto))]

  return (
    <section className="ss-card">
      {embedded
        ? <h3 className="ss-names-head">Names &amp; places <small>same place or same person written two ways? Make it one.</small></h3>
        : <h3 className="ss-names-head" onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>{open ? '▾' : '▸'} Names &amp; places <small>same place or same person written two ways? Make it one.</small></h3>}
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
                      <button type="button" disabled={busy} onClick={() => merge(names, names[0])}>Merge into {names[0]}</button>
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
                  <button type="button" disabled={busy || !keep.trim()} onClick={() => merge(picked, keep.trim())}>Merge {picked.length} names</button>
                </div>
              )}
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
