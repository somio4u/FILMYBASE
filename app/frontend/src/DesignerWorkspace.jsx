// What a "designer" login sees: only the design tasks assigned to them.
// Nothing else in the app is reachable from this login (the server refuses
// everything outside /api/designer, so this screen is a convenience, not the
// lock).
import { useCallback, useEffect, useState } from 'react'
import './ProductionDossier.css'
import TaskBrief from './TaskBrief.jsx'
import TaskComments from './TaskComments.jsx'
import SubmissionPanel from './SubmissionPanel.jsx'

const STATE_TEXT = {
  open: 'Not started',
  claimed: 'Assigned to you',
  submitted: 'Waiting for review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
}

export default function DesignerWorkspace({ currentUser, backendUrl, onLogout }) {
  const api = `${backendUrl}/api/designer`
  const [tasks, setTasks] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [task, setTask] = useState(null)
  const [error, setError] = useState(null)

  const loadList = useCallback(async () => {
    try {
      const response = await fetch(`${api}/tasks`)
      if (!response.ok) throw new Error('failed')
      setTasks((await response.json()).tasks)
      setError(null)
    } catch {
      setError('Could not load your tasks. Check your connection and try again.')
    }
  }, [api])

  const loadTask = useCallback(async () => {
    if (!selectedId) { setTask(null); return }
    try {
      const response = await fetch(`${api}/tasks/${selectedId}`)
      if (!response.ok) throw new Error('failed')
      setTask(await response.json())
    } catch {
      setError('Could not load this task.')
    }
  }, [api, selectedId])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { loadTask() }, [loadTask])

  const refresh = async () => { await loadTask(); await loadList() }

  return (
    <main className="designer-workspace dossier">
      <header className="dossier-header">
        <div>
          <h2>Design tasks</h2>
          <p className="dossier-summary">Hello {currentUser.name}. {tasks === null ? 'Loading…' : tasks.length === 0 ? 'No tasks have been assigned to you yet.' : `${tasks.length} task${tasks.length === 1 ? '' : 's'} assigned to you.`}</p>
        </div>
        <div className="dossier-header-actions">
          <button type="button" className="dossier-small-button" onClick={onLogout}>Log out</button>
        </div>
      </header>
      {error && <p className="dossier-error" role="alert">{error}</p>}

      <div className="dossier-body">
        <ul className="dossier-list" aria-label="Your design tasks">
          {(tasks ?? []).map((t) => (
            <li key={t.id}>
              <button type="button" className={t.id === selectedId ? 'dossier-row active' : 'dossier-row'} onClick={() => setSelectedId(t.id)}>
                <span className="dossier-code">{t.code}</span>
                <span className="dossier-row-name">{t.asset.name}</span>
                <span className="dossier-fine-print">{STATE_TEXT[t.state] ?? t.state}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="dossier-detail">
          {task ? (
            <article className="dossier-task">
              <h3><span className="dossier-code">{task.code}</span> {task.brief.asset.name}</h3>
              <p className="dossier-fine-print">
                {task.brief.asset.code} · {task.brief.asset.kind} · {STATE_TEXT[task.state] ?? task.state}
                {task.dueDate ? ` · due ${task.dueDate}` : ''} · {task.priority} priority
                {task.brief.sceneUsage.length > 0 ? ` · used in ${task.brief.sceneUsage.join(', ')}` : ''}
              </p>
              {task.briefStale && <p className="dossier-message" role="status">The production team changed this item after the brief was written. Ask them for the updated brief before you start.</p>}
              <TaskBrief brief={task.brief} />
              <SubmissionPanel task={task} apiBase={`${api}/tasks/${task.id}`} mediaUrl={(id) => `${api}/media/${id}`} onChanged={refresh} />
              <TaskComments comments={task.comments} commentsUrl={`${api}/tasks/${task.id}/comments`} onChanged={refresh} questionLabel="Question for the production team" />
            </article>
          ) : (
            <p className="dossier-empty">{tasks && tasks.length > 0 ? 'Pick a task to see its brief.' : ''}</p>
          )}
        </div>
      </div>
    </main>
  )
}
