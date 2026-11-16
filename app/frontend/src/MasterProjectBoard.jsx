import { useMemo, useState } from 'react'

// The admin's "All your projects" screen, organised: one tab per person (everything that person is working on),
// plus "Not assigned yet". Each card says what stage the project is in, whether that step is approved, and who works on it.
const STAGES = [
  ['story', 'Story'],
  ['synopsis', 'Synopsis'],
  ['characters', 'Characters'],
  ['structure', 'Story structure'],
  ['beats', 'Beats'],
  ['screenplay', 'Screenplay'],
  ['done', 'Screenplay done'],
]
const STAGE_LABEL = Object.fromEntries(STAGES)
const KINDS = [['film', '🎬 Film'], ['short', '🎞️ Short film'], ['series', '📺 Web series'], ['vertical', '📱 Vertical drama']]
const KIND_LABEL = Object.fromEntries(KINDS)
const ROLE = { screenplay_writer: 'Writer', director: 'Director', production_manager: 'AD', independent_writer: 'Writer' }

export function stageText(p) {
  const label = STAGE_LABEL[p.stageKey] ?? 'Story'
  if (p.stageKey === 'done') return 'Screenplay done — ready for production'
  if (p.stageKey === 'story') return 'In the story stage — not started yet'
  return p.stageApproved ? `${label} approved — next step is waiting` : `${label} stage — waiting for approval`
}

const when = (iso) => { try { return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '' } catch { return '' } }

export default function MasterProjectBoard({ projects, isAdmin, selectedIds, onToggle, onOpen, onRename, onDelete, icons, typeLabel }) {
  const [tab, setTab] = useState('all')
  const [stage, setStage] = useState('all')
  const [kind, setKind] = useState('all')

  // one tab per assigned person; a project with two people shows under both
  const people = useMemo(() => {
    const map = new Map()
    projects.forEach((p) => p.assignedUsers.forEach((u) => map.set(u.name, (map.get(u.name) ?? 0) + 1)))
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [projects])
  const unassigned = projects.filter((p) => p.assignedUsers.length === 0)

  const inTab = (p) => (tab === 'all' ? true : tab === '__none' ? p.assignedUsers.length === 0 : p.assignedUsers.some((u) => u.name === tab))
  const shown = projects.filter((p) => inTab(p) && (stage === 'all' || p.stageKey === stage) && (kind === 'all' || p.formatKind === kind))
  const stageCounts = useMemo(() => {
    const c = {}
    projects.filter(inTab).forEach((p) => { c[p.stageKey] = (c[p.stageKey] ?? 0) + 1 })
    return c
  }, [projects, tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const tabBtn = (key, label, count) => (
    <button key={key} type="button" className={`board-tab${tab === key ? ' board-tab-on' : ''}`} onClick={() => { setTab(key); setStage('all') }}>
      {label} <span className="board-count">{count}</span>
    </button>
  )

  return (
    <div className="master-board">
      <div className="board-tabs" role="tablist">
        {tabBtn('all', 'Everyone', projects.length)}
        {people.map(([name, n]) => tabBtn(name, name, n))}
        {unassigned.length > 0 && tabBtn('__none', 'Not assigned yet', unassigned.length)}
      </div>
      <div className="board-stages">
        <button type="button" className={`board-chip${stage === 'all' ? ' board-chip-on' : ''}`} onClick={() => setStage('all')}>All stages</button>
        {STAGES.filter(([k]) => stageCounts[k]).map(([k, label]) => (
          <button key={k} type="button" className={`board-chip${stage === k ? ' board-chip-on' : ''}`} onClick={() => setStage(k)}>{label} · {stageCounts[k]}</button>
        ))}
      </div>
      <div className="board-stages">
        <button type="button" className={`board-chip${kind === 'all' ? ' board-chip-on' : ''}`} onClick={() => setKind('all')}>All types</button>
        {KINDS.filter(([k]) => projects.some((p) => inTab(p) && p.formatKind === k)).map(([k, label]) => (
          <button key={k} type="button" className={`board-chip${kind === k ? ' board-chip-on' : ''}`} onClick={() => setKind(k)}>{label} · {projects.filter((p) => inTab(p) && p.formatKind === k).length}</button>
        ))}
      </div>
      {shown.length === 0 && <p className="sidebar-section-note">Nothing here.</p>}
      <div className="master-list-grid">
        {shown.map((p) => (
          <div key={p.id} className="master-list-card">
            <button className="master-list-card-open" onClick={() => onOpen(p)}>
              <strong>{p.title}</strong>
              <span className="board-stage" data-stage={p.stageKey} data-ok={p.stageApproved ? '1' : '0'}>{STAGE_LABEL[p.stageKey] ?? 'Story'}{p.stageKey !== 'story' && p.stageKey !== 'done' ? (p.stageApproved ? ' ✓' : ' …') : p.stageKey === 'done' ? ' ✓' : ''}</span>
              <span className="breakdown-item-meta">{stageText(p)}</span>
              <span className="breakdown-item-meta">{KIND_LABEL[p.formatKind] ?? '🎬 Film'}{p.formatDetail ? ` · ${p.formatDetail}` : ''} · {typeLabel(p)}{p.lastWorkedAt ? ` · last worked ${when(p.lastWorkedAt)}` : ''}</span>
              <div className="master-list-assignments">
                {p.assignedUsers.length === 0 && <span className="breakdown-item-meta">No one on this yet</span>}
                {p.assignedUsers.map((u, i) => (
                  <span key={i} className="master-list-assignment-badge">{ROLE[u.role] ?? u.role}: {u.name}</span>
                ))}
              </div>
            </button>
            <div className="master-list-card-actions">
              {isAdmin && <input type="checkbox" className="master-list-card-checkbox" checked={selectedIds.has(p.id)} onChange={() => onToggle(p.id)} title="Select this project" />}
              <button className="sidebar-history-icon-button" onClick={() => onRename(p)} title="Rename">{icons.pencil}</button>
              {isAdmin && <button className="sidebar-history-icon-button" onClick={() => onDelete(p)} title="Delete">{icons.trash}</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
