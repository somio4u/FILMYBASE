// Production Dossier: the working list of every character, prop, location and
// other asset the silent agent found, with what is still missing. Every
// number on this screen comes from saved records (the backend counts them).
// English only for now (the rest of the production workflow is not translated yet).

import { useCallback, useEffect, useMemo, useState } from 'react'
import './ProductionDossier.css'
import TaskBrief from './TaskBrief.jsx'
import TaskComments from './TaskComments.jsx'
import SubmissionPanel from './SubmissionPanel.jsx'
import DriveCard from './DriveCard.jsx'

const KIND_TABS = [
  { key: 'character', label: 'Characters' },
  { key: 'prop', label: 'Properties' },
  { key: 'location', label: 'Locations' },
  { key: 'other', label: 'Other assets' },
  { key: 'tasks', label: 'Designer tasks' },
  { key: 'issues', label: 'Issues' },
]

const IMPORT_STATUS_TEXT = {
  received: 'Received',
  mapping: 'Mapping…',
  ready: 'Ready',
  partially_ready: 'Partially ready: some items need review',
  failed: 'Failed',
}

const ISSUE_CATEGORY_TEXT = {
  missing_info: 'Missing information',
  agent_update: 'Agent changed an edited item',
  ambiguous_match: 'Needs a decision',
  duplicate_in_output: 'Listed twice',
  quarantined: 'Skipped entry',
}

// "CONFLICT: ..." / "DECISION: ..." notes written by the agent are the ones
// that block a designer, so they are shown in a stronger colour.
function issueTone(issue) {
  if (/^(CONFLICT|DECISION)/.test(issue.message) || issue.category === 'ambiguous_match') return 'needs-decision'
  return issue.category === 'missing_info' ? 'missing' : 'info'
}

function listToText(list) {
  return (list ?? []).join('\n')
}
function textToList(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

export default function ProductionDossier({ projectId, backendUrl, onProjectCreated }) {
  const [overview, setOverview] = useState(null)
  const [assets, setAssets] = useState([])
  const [issues, setIssues] = useState([])
  const [tasks, setTasks] = useState([])
  const [selectedTaskId, setSelectedTaskId] = useState(null)
  const [tab, setTab] = useState('character')
  const [selectedId, setSelectedId] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [isBusy, setIsBusy] = useState(false)
  const [message, setMessage] = useState(null)

  const api = `${backendUrl}/api/production`

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const [o, a, i, tk] = await Promise.all([
        fetch(`${api}/${projectId}/overview`).then((r) => (r.ok ? r.json() : Promise.reject(r))),
        fetch(`${api}/${projectId}/assets`).then((r) => (r.ok ? r.json() : Promise.reject(r))),
        fetch(`${api}/${projectId}/issues`).then((r) => (r.ok ? r.json() : Promise.reject(r))),
        fetch(`${api}/${projectId}/tasks`).then((r) => (r.ok ? r.json() : { tasks: [] })).catch(() => ({ tasks: [] })),
      ])
      setOverview(o)
      setAssets(a.assets)
      setIssues(i.issues)
      setTasks(tk.tasks)
      setLoadError(null)
    } catch {
      setLoadError('Could not load the dossier. Check your connection and try again.')
    }
  }, [api, projectId])

  useEffect(() => {
    setSelectedId(null)
    setSelectedTaskId(null)
    setMessage(null)
    reload()
  }, [reload])

  async function importFromAgent() {
    setIsBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`${api}/${projectId}/import`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) setMessage(data.error || 'Import failed.')
      else if (data.outcome === 'duplicate') setMessage('Nothing new: the agent’s output has not changed since the last import.')
      else if (data.outcome === 'failed') setMessage(data.error)
      else setMessage(`Imported: ${data.summary.created} new, ${data.summary.updated} updated, ${data.summary.unchanged} unchanged.`)
      await reload()
    } catch {
      setMessage('Could not reach the server.')
    }
    setIsBusy(false)
  }

  // On a phone the details sit below the list: bring them into view.
  useEffect(() => {
    if (selectedId && window.matchMedia('(max-width: 760px)').matches) {
      document.querySelector('.dossier-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [selectedId])

  const visibleAssets = useMemo(() => assets.filter((a) => a.kind === tab), [assets, tab])
  const selected = assets.find((a) => a.id === selectedId) ?? null
  const counts = overview?.assetsByKind ?? {}
  const lastImport = overview?.lastImport

  if (!projectId) {
    return <p className="dossier-note">Open or create an AI Movie project first.</p>
  }

  return (
    <div className="dossier">
      <header className="dossier-header">
        <div>
          <h2>Production Dossier</h2>
          {lastImport ? (
            <p className="dossier-summary">
              <span className={`dossier-status dossier-status-${lastImport.status}`}>{IMPORT_STATUS_TEXT[lastImport.status] ?? lastImport.status}</span>{' '}
              {lastImport.status === 'failed'
                ? lastImport.error
                : `${counts.character ?? 0} characters · ${counts.prop ?? 0} properties · ${counts.location ?? 0} locations · ${counts.other ?? 0} other assets · ${issues.length} open ${issues.length === 1 ? 'issue' : 'issues'}`}
            </p>
          ) : (
            <p className="dossier-summary">Nothing imported yet. The silent agent’s list has not been read into the dossier.</p>
          )}
          {lastImport && (
            <p className="dossier-fine-print">
              Output {overview.importsReceived > 1 ? `version ${overview.importsReceived}` : 'received'} · screenplay {lastImport.completion_state === 'complete' ? 'approved' : 'still in progress'} · {new Date(lastImport.received_at).toLocaleString()}
            </p>
          )}
        </div>
        <div className="dossier-header-actions">
          <button type="button" className="choose-button" onClick={importFromAgent} disabled={isBusy}>
            {isBusy ? 'Working…' : lastImport ? 'Re-import from agent' : 'Import from agent'}
          </button>
        </div>
      </header>

      <DriveCard projectId={projectId} backendUrl={backendUrl} />

      {message && <p className="dossier-message" role="status">{message}</p>}
      {loadError && <p className="dossier-error" role="alert">{loadError}</p>}

      <nav className="dossier-tabs" aria-label="Dossier sections">
        {KIND_TABS.map(({ key, label }) => {
          const n = key === 'issues' ? issues.length : key === 'tasks' ? tasks.filter((t) => t.state !== 'cancelled').length : counts[key] ?? 0
          return (
            <button
              key={key}
              type="button"
              className={tab === key ? 'dossier-tab active' : 'dossier-tab'}
              onClick={() => { setTab(key); setSelectedId(null); setSelectedTaskId(null) }}
            >
              {label} <span className="dossier-tab-count">{n}</span>
            </button>
          )
        })}
      </nav>

      {tab === 'tasks' ? (
        <TasksView
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onSelect={setSelectedTaskId}
          projectId={projectId}
          api={api}
          onChanged={reload}
          hasAssets={assets.length > 0}
        />
      ) : tab === 'issues' ? (
        <IssueList issues={issues} projectId={projectId} api={api} onChanged={reload} onOpenAsset={(assetId) => {
          const asset = assets.find((a) => a.id === assetId)
          if (asset) { setTab(asset.kind); setSelectedId(asset.id) }
        }} />
      ) : (
        <div className="dossier-body">
          <ul className="dossier-list" aria-label={KIND_TABS.find((t) => t.key === tab)?.label}>
            {visibleAssets.length === 0 && <li className="dossier-empty">Nothing here yet.</li>}
            {visibleAssets.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  className={asset.id === selectedId ? 'dossier-row active' : 'dossier-row'}
                  onClick={() => setSelectedId(asset.id)}
                >
                  <span className="dossier-code">{asset.code}</span>
                  <span className="dossier-row-name">{asset.name}</span>
                  {asset.hasHumanEdits && <span className="dossier-badge edited">edited</span>}
                  {asset.openIssues.length > 0 && <span className="dossier-badge issues">{asset.openIssues.length}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="dossier-detail">
            {selected ? (
              <AssetDetail
                key={`${selected.id}-${selected.revision}`}
                asset={selected}
                projectId={projectId}
                api={api}
                onSaved={reload}
                onIssueDismissed={reload}
                task={tasks.find((t) => t.asset.id === selected.id && ['open', 'claimed', 'submitted', 'changes_requested'].includes(t.state)) ?? null}
                onOpenTask={(taskId) => { setTab('tasks'); setSelectedTaskId(taskId) }}
              />
            ) : (
              <p className="dossier-empty">Pick an item to see its details.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function IssueList({ issues, projectId, api, onChanged, onOpenAsset }) {
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  async function dismiss(issue) {
    setBusyId(issue.id)
    setError(null)
    try {
      const response = await fetch(`${api}/${projectId}/issues/${issue.id}/dismiss`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      if (!response.ok) setError((await response.json()).error || 'Could not close this issue.')
      await onChanged()
    } catch {
      setError('Could not reach the server.')
    }
    setBusyId(null)
  }
  if (issues.length === 0) return <p className="dossier-empty">No open issues.</p>
  return (
    <div>
      {error && <p className="dossier-error" role="alert">{error}</p>}
      <ul className="dossier-issues">
        {issues.map((issue) => (
          <li key={issue.id} className={`dossier-issue tone-${issueTone(issue)}`}>
            <div>
              <span className="dossier-issue-kind">{ISSUE_CATEGORY_TEXT[issue.category] ?? issue.category}</span>
              {issue.asset_id && (
                <button type="button" className="dossier-link-button" onClick={() => onOpenAsset(issue.asset_id)}>
                  {issue.asset_code} {issue.asset_name}
                </button>
              )}
              <p>{issue.message}</p>
            </div>
            <button type="button" className="dossier-small-button" disabled={busyId === issue.id} onClick={() => dismiss(issue)}>
              Not needed
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function AssetDetail({ asset, projectId, api, onSaved, onIssueDismissed, task, onOpenTask }) {
  const d = asset.details
  const [descEn, setDescEn] = useState(d.description?.en ?? '')
  const [descHi, setDescHi] = useState(d.description?.hi ?? '')
  const [states, setStates] = useState(listToText(d.states))
  const [sceneRefs, setSceneRefs] = useState(listToText(d.sceneRefs))
  const [notes, setNotes] = useState(d.notes ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const original = asset.importedOriginal

  async function save() {
    setIsSaving(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch(`${api}/${projectId}/assets/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: asset.revision,
          edits: { description: { en: descEn, hi: descHi }, states: textToList(states), sceneRefs: textToList(sceneRefs), notes },
        }),
      })
      const data = await response.json()
      if (response.status === 409) setError(data.error)
      else if (!response.ok) setError(data.error || 'Could not save.')
      else setSaved(true)
      await onSaved()
    } catch {
      setError('Could not reach the server.')
    }
    setIsSaving(false)
  }

  async function dismiss(issue) {
    await fetch(`${api}/${projectId}/issues/${issue.id}/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })
    onIssueDismissed()
  }

  return (
    <article className="dossier-asset">
      <h3>
        <span className="dossier-code">{asset.code}</span> {asset.name}
      </h3>
      {asset.aliases.length > 0 && <p className="dossier-fine-print">Also called: {asset.aliases.join(', ')}</p>}
      <p className="dossier-fine-print">
        Status: {asset.reviewStatus === 'approved' ? 'approved' : 'needs design'} · from agent output (not approved) · {asset.inLatestImport ? 'in the latest import' : 'no longer in the latest agent output'}
      </p>

      {asset.openIssues.length > 0 && (
        <section className="dossier-section">
          <h4>Still needed</h4>
          <OpenIssuesForAsset assetId={asset.id} issuesApi={`${api}/${projectId}`} onDismiss={dismiss} />
        </section>
      )}

      <section className="dossier-section">
        <h4>Description</h4>
        <label className="dossier-field">
          English
          <textarea value={descEn} onChange={(e) => setDescEn(e.target.value)} rows={4} />
        </label>
        <label className="dossier-field">
          हिन्दी (Hindi)
          <textarea value={descHi} onChange={(e) => setDescHi(e.target.value)} rows={3} lang="hi" />
        </label>
      </section>

      <section className="dossier-section">
        <h4>Conditions it appears in</h4>
        <label className="dossier-field">
          One per line (for example: sealed, opened)
          <textarea value={states} onChange={(e) => setStates(e.target.value)} rows={3} />
        </label>
      </section>

      <section className="dossier-section">
        <h4>Scenes it appears in</h4>
        <label className="dossier-field">
          One per line (for example: Scene 4)
          <textarea value={sceneRefs} onChange={(e) => setSceneRefs(e.target.value)} rows={3} />
        </label>
      </section>

      {asset.kind === 'character' && (d.costumes ?? []).length > 0 && (
        <section className="dossier-section">
          <h4>Costumes</h4>
          <ul className="dossier-costumes">
            {d.costumes.map((c) => (
              <li key={c.name}><strong>{c.name}</strong>{c.description ? `: ${c.description}` : ''}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="dossier-section">
        <h4>Your notes</h4>
        <label className="dossier-field">
          For the designer or reviewer
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </label>
      </section>

      <section className="dossier-section">
        <h4>Designer task</h4>
        {task ? (
          <p>
            <button type="button" className="dossier-link-button" onClick={() => onOpenTask(task.id)}>{task.code}</button>
            {' '}is {TASK_STATE_TEXT[task.state] ?? task.state}{task.assignee ? ` (${task.assignee})` : ''}.
          </p>
        ) : (
          <CreateTaskButton assetId={asset.id} projectId={projectId} api={api} onCreated={(taskId) => { onSaved(); onOpenTask(taskId) }} />
        )}
      </section>

      <div className="dossier-save-row">
        <button type="button" className="choose-button" onClick={save} disabled={isSaving}>
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
        {saved && <span className="dossier-ok" role="status">Saved.</span>}
        {error && <span className="dossier-bad" role="alert">{error}</span>}
      </div>

      {asset.hasHumanEdits && (
        <details className="dossier-original">
          <summary>What the agent originally said</summary>
          <p>{original.description?.en || '(no English description)'}</p>
          {original.description?.hi && <p lang="hi">{original.description.hi}</p>}
          <p className="dossier-fine-print">Your edits are kept on top of this. If the agent changes its version later, your edits stay.</p>
        </details>
      )}
    </article>
  )
}

// The asset's own open issues come with the asset list already; this small
// view shows them with a button to close each one.
function OpenIssuesForAsset({ assetId, issuesApi, onDismiss }) {
  const [list, setList] = useState(null)
  useEffect(() => {
    let cancelled = false
    fetch(`${issuesApi}/issues`).then((r) => r.json()).then((data) => {
      if (!cancelled) setList(data.issues.filter((i) => i.asset_id === assetId))
    }).catch(() => { if (!cancelled) setList([]) })
    return () => { cancelled = true }
  }, [assetId, issuesApi])
  if (list === null) return <p className="dossier-fine-print">Loading…</p>
  return (
    <ul className="dossier-issues compact">
      {list.map((issue) => (
        <li key={issue.id} className={`dossier-issue tone-${issueTone(issue)}`}>
          <p>{issue.message}</p>
          <button type="button" className="dossier-small-button" onClick={() => onDismiss(issue).then(() => setList((prev) => prev.filter((x) => x.id !== issue.id)))}>
            Not needed
          </button>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Designer tasks
// ---------------------------------------------------------------------------

const TASK_STATE_TEXT = {
  open: 'open (nobody assigned)',
  claimed: 'assigned',
  submitted: 'submitted for review',
  changes_requested: 'waiting for changes',
  approved: 'approved',
  cancelled: 'cancelled',
}

const PRIORITY_TEXT = { low: 'Low', normal: 'Normal', high: 'High' }

function CreateTaskButton({ assetId, projectId, api, onCreated }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function create() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${api}/${projectId}/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: [assetId] }),
      })
      const data = await response.json()
      if (!response.ok) setError(data.error || 'Could not create the task.')
      else if (data.created.length === 0) setError('This item already has a task.')
      else onCreated(data.created[0].taskId)
    } catch {
      setError('Could not reach the server.')
    }
    setBusy(false)
  }
  return (
    <div>
      <button type="button" className="dossier-small-button" onClick={create} disabled={busy}>
        {busy ? 'Creating…' : 'Create designer task'}
      </button>
      {error && <span className="dossier-bad" role="alert"> {error}</span>}
    </div>
  )
}

function TasksView({ tasks, selectedTaskId, onSelect, projectId, api, onChanged, hasAssets }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const selected = tasks.find((t) => t.id === selectedTaskId) ?? null

  async function createAll() {
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch(`${api}/${projectId}/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      const data = await response.json()
      if (!response.ok) setNotice(data.error || 'Could not create tasks.')
      else setNotice(data.created.length === 0 ? 'Every item already has a task.' : `Created ${data.created.length} task${data.created.length === 1 ? '' : 's'}.`)
      await onChanged()
    } catch {
      setNotice('Could not reach the server.')
    }
    setBusy(false)
  }

  const visible = tasks.filter((t) => t.state !== 'cancelled')
  return (
    <div>
      <div className="dossier-task-actions">
        <button type="button" className="choose-button" onClick={createAll} disabled={busy || !hasAssets}>
          {busy ? 'Creating…' : 'Create tasks for every item without one'}
        </button>
        {notice && <span role="status" className="dossier-fine-print">{notice}</span>}
      </div>
      <div className="dossier-body">
        <ul className="dossier-list" aria-label="Designer tasks">
          {visible.length === 0 && <li className="dossier-empty">No designer tasks yet. Create them from here, or from an item’s page.</li>}
          {visible.map((task) => (
            <li key={task.id}>
              <button type="button" className={task.id === selectedTaskId ? 'dossier-row active' : 'dossier-row'} onClick={() => onSelect(task.id)}>
                <span className="dossier-code">{task.code}</span>
                <span className="dossier-row-name">{task.asset.name}</span>
                {task.needsDecisionCount > 0 && <span className="dossier-badge decisions" title="Open decisions">{task.needsDecisionCount}</span>}
                {task.briefStale && <span className="dossier-badge stale" title="Brief is out of date">!</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="dossier-detail">
          {selected ? (
            <TaskDetail key={selected.id} taskId={selected.id} listRevision={selected.revision} projectId={projectId} api={api} onChanged={onChanged} />
          ) : (
            <p className="dossier-empty">Pick a task to see its brief.</p>
          )}
        </div>
      </div>
    </div>
  )
}

function TaskDetail({ taskId, listRevision, projectId, api, onChanged }) {
  const [task, setTask] = useState(null)
  const [designers, setDesigners] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [assigneeUserId, setAssigneeUserId] = useState('')
  const [assigneeName, setAssigneeName] = useState('')
  const [priority, setPriority] = useState('normal')
  const [dueDate, setDueDate] = useState('')
  const [saved, setSaved] = useState(false)
  const taskApi = `${api}/${projectId}/tasks/${taskId}`

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${api}/${projectId}/tasks/${taskId}`)
      if (!response.ok) throw new Error('load failed')
      const data = await response.json()
      setTask(data)
      setAssigneeUserId(data.assigneeUserId ? String(data.assigneeUserId) : '')
      setAssigneeName(data.assigneeUserId ? '' : data.assignee ?? '')
      setPriority(data.priority)
      setDueDate(data.dueDate ?? '')
      setError(null)
    } catch {
      setError('Could not load this task.')
    }
  }, [api, projectId, taskId])

  // Reload whenever the list says this task's revision moved on.
  useEffect(() => { load() }, [load, listRevision])
  useEffect(() => {
    fetch(`${api}/designers`).then((r) => (r.ok ? r.json() : { designers: [] })).then((d) => setDesigners(d.designers)).catch(() => {})
  }, [api])

  // Runs a write, shows the server's message on failure, then reloads.
  async function run(path, method, body, successNote) {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch(`${taskApi}${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await response.json()
      if (!response.ok) setError(data.error || 'That did not work.')
      else if (successNote) setSaved(successNote)
      await load()
      await onChanged()
      return response.ok
    } catch {
      setError('Could not reach the server.')
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!task) return <p className="dossier-fine-print" role={error ? 'alert' : undefined}>{error ?? 'Loading…'}</p>
  const brief = task.brief
  const editable = ['open', 'claimed', 'changes_requested'].includes(task.state)
  const reload = async () => { await load(); await onChanged() }

  return (
    <article className="dossier-task">
      <h3>
        <span className="dossier-code">{task.code}</span> {brief.asset.name}
      </h3>
      <p className="dossier-fine-print">
        {brief.asset.code} · {brief.asset.kind} · {TASK_STATE_TEXT[task.state] ?? task.state}
        {task.assignee ? ` · ${task.assignee}${task.assigneeUserId ? ' (has a login)' : ' (no login)'}` : ''}
        {brief.sceneUsage.length > 0 ? ` · used in ${brief.sceneUsage.join(', ')}` : ''}
      </p>

      {task.briefStale && editable && (
        <p className="dossier-message" role="status">
          The item changed after this brief was written.{' '}
          <button type="button" className="dossier-small-button" disabled={busy} onClick={() => run('/refresh-brief', 'POST', { expectedRevision: task.revision }, 'Brief updated.')}>
            Update the brief
          </button>
        </p>
      )}

      <TaskBrief brief={brief} />

      {editable && (
        <section className="dossier-section dossier-task-controls">
          <h4>Assignment</h4>
          <div className="dossier-controls-row">
            <label className="dossier-field">
              Designer login
              <select value={assigneeUserId} onChange={(e) => setAssigneeUserId(e.target.value)}>
                <option value="">(no login)</option>
                {designers.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.username})</option>)}
              </select>
            </label>
            {!assigneeUserId && (
              <label className="dossier-field">
                Or a name without a login
                <input value={assigneeName} onChange={(e) => setAssigneeName(e.target.value)} maxLength={100} placeholder="Designer’s name" />
              </label>
            )}
            <label className="dossier-field">
              Priority
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {Object.entries(PRIORITY_TEXT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="dossier-field">
              Due date
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
          </div>
          <p className="dossier-fine-print">Only a designer login can see this task and upload files. A name alone is just a label.</p>
          <div className="dossier-save-row">
            <button
              type="button"
              className="choose-button"
              disabled={busy}
              onClick={() => run('', 'PATCH', {
                expectedRevision: task.revision,
                ...(assigneeUserId ? { assigneeUserId: Number(assigneeUserId) } : { assignee: assigneeName.trim() || null }),
                priority,
                dueDate: dueDate || null,
              }, 'Saved.')}
            >
              Save assignment
            </button>
            <button
              type="button"
              className="dossier-small-button"
              disabled={busy}
              onClick={() => { if (window.confirm('Cancel this task? You can create a new one for the same item later.')) run('/cancel', 'POST', { expectedRevision: task.revision }) }}
            >
              Cancel task
            </button>
            {saved && <span className="dossier-ok" role="status">{saved}</span>}
          </div>
        </section>
      )}
      {error && <p className="dossier-bad" role="alert">{error}</p>}

      <SubmissionPanel task={task} apiBase={taskApi} mediaUrl={(id) => `${api}/media/${id}`} onChanged={reload} />

      <TaskComments comments={task.comments} commentsUrl={`${taskApi}/comments`} onChanged={reload} />
    </article>
  )
}
