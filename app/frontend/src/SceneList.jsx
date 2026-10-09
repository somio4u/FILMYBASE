// Pipeline step 1 screen: the screenplay split into scenes. Each scene shows
// where and when it happens, which characters / props / places from the
// dossier are in it, and every action, dialogue line (with its permanent id)
// and shot note from the script.
import { useCallback, useEffect, useState } from 'react'

const KIND_TEXT = { character: 'Characters', prop: 'Props', location: 'Places', other: 'Other' }

export default function SceneList({ projectId, api, onOpenAsset, refreshKey, onAnalyzed }) {
  const [scenes, setScenes] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [scene, setScene] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${api}/${projectId}/scenes`)
      if (!response.ok) throw new Error('load failed')
      setScenes((await response.json()).scenes)
    } catch {
      setMessage({ tone: 'bad', text: 'Could not load the scenes. Check your connection.' })
    }
  }, [api, projectId])

  useEffect(() => { load() }, [load, refreshKey])

  useEffect(() => {
    if (!selectedId) { setScene(null); return }
    let cancelled = false
    fetch(`${api}/${projectId}/scenes/${selectedId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled) setScene(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [api, projectId, selectedId, scenes])

  async function analyze() {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`${api}/${projectId}/analyze-screenplay`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) setMessage({ tone: 'bad', text: data.error || 'Could not analyze the screenplay.' })
      else if (data.outcome === 'no_screenplay') setMessage({ tone: 'bad', text: `${data.message}${data.warnings?.length ? ' ' + data.warnings[0] : ''}` })
      else {
        const s = data.summary
        const parts = [`${s.scenes} scenes`, `${s.dialogueLines} dialogue lines`, `${s.shotHints} shot notes in the script`]
        const changed = s.created + s.updated + s.removed > 0 ? ` (${s.created} new, ${s.updated} changed, ${s.removed} removed)` : ' (nothing changed)'
        const unknown = s.unknownSpeakers.length > 0 ? ` Not in the dossier: ${s.unknownSpeakers.join(', ')}.` : ''
        setMessage({ tone: 'ok', text: `Read ${parts.join(', ')}${changed}.${unknown}` })
      }
      await load()
      if (onAnalyzed) await onAnalyzed()
    } catch {
      setMessage({ tone: 'bad', text: 'Could not reach the server.' })
    }
    setBusy(false)
  }

  const totals = (scenes ?? []).reduce((t, s) => ({ d: t.d + s.counts.dialogue, h: t.h + s.counts.shotHints }), { d: 0, h: 0 })

  return (
    <div>
      <div className="dossier-task-actions">
        <button type="button" className="choose-button" onClick={analyze} disabled={busy}>
          {busy ? 'Reading the screenplay…' : scenes && scenes.length > 0 ? 'Analyze the screenplay again' : 'Analyze the screenplay'}
        </button>
        {scenes && scenes.length > 0 && <span className="dossier-fine-print">{scenes.length} scenes · {totals.d} dialogue lines · {totals.h} shot notes in the script</span>}
      </div>
      {message && <p className={message.tone === 'bad' ? 'dossier-bad' : 'dossier-ok'} role="status">{message.text}</p>}

      {scenes && scenes.length === 0 && (
        <p className="dossier-empty">No scenes yet. Press “Analyze the screenplay” to split the screenplay into scenes, actions and dialogue lines. It uses no AI and costs nothing.</p>
      )}

      {scenes && scenes.length > 0 && (
        <div className="dossier-body">
          <ul className="dossier-list" aria-label="Scenes">
            {scenes.map((s) => (
              <li key={s.id}>
                <button type="button" className={s.id === selectedId ? 'dossier-row active' : 'dossier-row'} onClick={() => setSelectedId(s.id)}>
                  <span className="dossier-code">{s.code}</span>
                  <span className="dossier-row-name">{s.number}. {s.location ?? s.heading}{s.timeOfDay ? <span className="dossier-fine-print"> · {s.timeOfDay}</span> : null}</span>
                  {s.counts.dialogue > 0 && <span className="dossier-badge edited" title="Dialogue lines">{s.counts.dialogue}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="dossier-detail">
            {scene ? <SceneDetail scene={scene} onOpenAsset={onOpenAsset} /> : <p className="dossier-empty">Pick a scene to read it.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function SceneDetail({ scene, onOpenAsset }) {
  const actions = scene.elements.filter((e) => e.kind !== 'shot_hint')
  const shots = scene.elements.filter((e) => e.kind === 'shot_hint')
  const grouped = Object.keys(KIND_TEXT).map((kind) => [kind, scene.assets.filter((a) => a.kind === kind)]).filter(([, list]) => list.length > 0)
  return (
    <article className="scene-detail">
      <h3><span className="dossier-code">{scene.code}</span> Scene {scene.number}</h3>
      <p className="scene-heading">{scene.heading}</p>
      <p className="dossier-fine-print">
        {[scene.qualifier, scene.intExt, scene.location, scene.timeOfDay].filter(Boolean).join(' · ')}
      </p>

      <section className="dossier-section">
        <h4>In this scene</h4>
        {grouped.length === 0 && <p className="dossier-fine-print">Nothing from the dossier was found in this scene.</p>}
        {grouped.map(([kind, list]) => (
          <p key={kind} className="scene-chips">
            <span className="dossier-fine-print">{KIND_TEXT[kind]}:</span>{' '}
            {list.map((a) => (
              <button key={a.id} type="button" className="scene-chip" onClick={() => onOpenAsset(a.id)} title={`Open ${a.code} in the dossier`}>{a.name}</button>
            ))}
          </p>
        ))}
      </section>

      <section className="dossier-section">
        <h4>What happens</h4>
        <ol className="scene-elements">
          {actions.map((e) => {
            if (e.kind === 'dialogue') {
              return (
                <li key={e.id} className="scene-dialogue">
                  <span className="dossier-code">{e.code}</span>{' '}
                  <strong>{e.speaker}{e.extension ? ` (${e.extension})` : ''}</strong>
                  {e.parenthetical ? <span className="dossier-fine-print"> ({e.parenthetical})</span> : null}
                  <p lang={e.language === 'hi' ? 'hi' : 'en'}>{e.text}</p>
                </li>
              )
            }
            if (e.kind === 'transition') return <li key={e.id} className="scene-transition">{e.text}</li>
            if (e.kind === 'note') return <li key={e.id} className="dossier-fine-print">Note: {e.text}</li>
            return <li key={e.id} className="scene-action"><p lang={e.language === 'hi' ? 'hi' : 'en'}>{e.text}</p></li>
          })}
        </ol>
      </section>

      {shots.length > 0 && (
        <details className="dossier-section">
          <summary>Shot notes already in the script ({shots.length})</summary>
          <p className="dossier-fine-print">These are only the writer’s notes. The shot division step will turn them into real, numbered shots.</p>
          <ul>{shots.map((e) => <li key={e.id}><strong>{e.label}</strong> — {e.text}</li>)}</ul>
        </details>
      )}
    </article>
  )
}
