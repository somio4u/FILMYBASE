// "Use material from the app" — a section of the Auto Screenplay agent's idea form. The agent can read (never change) every
// Film project and AI Movie project: idea, story, characters, structure, beats, scene list, screenplay, assets, reference files.
// It can look for related projects itself, and/or you can tick the ones it should read.

import { useEffect, useState } from 'react'

export default function WorkspaceSources({ backendUrl, idea, auto, onAuto, picked, onPicked }) {
  const [sources, setSources] = useState(null)
  const [filter, setFilter] = useState('')
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const q = encodeURIComponent(`${filter} ${idea ?? ''}`.slice(0, 400))
        const r = await fetch(`${backendUrl}/api/workspace/sources?q=${q}`)
        const data = await r.json().catch(() => ({}))
        if (!cancelled) setSources(r.ok ? data.sources : [])
      } catch {
        if (!cancelled) setSources([])
      }
    }, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [backendUrl, idea, filter])

  const key = (s) => `${s.kind}:${s.id}`
  const isPicked = (s) => picked.some((p) => p.kind === s.kind && p.id === s.id)
  const toggle = (s) => onPicked(isPicked(s) ? picked.filter((p) => !(p.kind === s.kind && p.id === s.id)) : [...picked, { kind: s.kind, id: s.id, title: s.title }])
  const shown = (sources ?? []).filter((s) => !filter || `${s.title} ${s.snippet}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 30)

  return (
    <details className="ws-sources">
      <summary>Use material from the app {picked.length > 0 || auto ? `(${auto ? 'agent searches' : ''}${auto && picked.length ? ' + ' : ''}${picked.length ? `${picked.length} chosen` : ''})` : '(off)'}</summary>
      <p className="ws-note">The agent can read any project in the app — idea, story, characters, structure, scene list, screenplay — but never changes them. Your new idea stays in charge; this is for continuity and inspiration.</p>
      <label className="ws-auto"><input type="checkbox" checked={auto} onChange={(e) => onAuto(e.target.checked)} /> Let the agent look through the app for related projects</label>
      <input type="search" className="ws-filter" placeholder="Search projects…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search projects" />
      {sources === null && <p className="ws-note">Looking…</p>}
      {sources && shown.length === 0 && <p className="ws-note">No projects found.</p>}
      <ul className="ws-list">
        {shown.map((s) => (
          <li key={key(s)}>
            <label>
              <input type="checkbox" checked={isPicked(s)} onChange={() => toggle(s)} />
              <span className="ws-title">{s.title}</span> <span className="ws-type">{s.type}</span>
              {s.matched > 0 && <span className="ws-match" title="shares words with your idea"> · related</span>}
              <small>{s.snippet}</small>
            </label>
          </li>
        ))}
      </ul>
    </details>
  )
}

// Shown on a run: which projects the agent actually read.
export function UsedSources({ sources }) {
  if (!Array.isArray(sources) || sources.length === 0) return null
  return (
    <p className="ws-used">
      Used material from: {sources.map((s) => `${s.title}${s.how === 'found by the agent' ? ' (found by the agent)' : ''}`).join(' · ')}
    </p>
  )
}
