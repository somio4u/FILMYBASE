// Comments and questions on a task. Works for the reviewer and the designer:
// the caller says which address to post to.
import { useState } from 'react'

export default function TaskComments({ comments, commentsUrl, onChanged, questionLabel = 'Question for the director' }) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState('comment')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function add() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(commentsUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text, kind }),
      })
      if (!response.ok) setError((await response.json()).error || 'Could not add the comment.')
      else {
        setText('')
        await onChanged()
      }
    } catch {
      setError('Could not reach the server.')
    }
    setBusy(false)
  }

  return (
    <section className="dossier-section">
      <h4>Comments and questions</h4>
      {comments.length === 0 && <p className="dossier-fine-print">No comments yet.</p>}
      <ul className="dossier-comments">
        {comments.map((c) => (
          <li key={c.id}>
            <span className="dossier-fine-print">{c.author_name || 'Someone'}{c.kind === 'clarification' ? ' · question' : ''} · {new Date(c.created_at).toLocaleString()}</span>
            <p>{c.body}</p>
          </li>
        ))}
      </ul>
      <label className="dossier-field">
        Add a comment
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={4000} />
      </label>
      <div className="dossier-save-row">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Comment type">
          <option value="comment">Comment</option>
          <option value="clarification">{questionLabel}</option>
        </select>
        <button type="button" className="dossier-small-button" disabled={busy || !text.trim()} onClick={add}>Add</button>
        {error && <span className="dossier-bad" role="alert">{error}</span>}
      </div>
    </section>
  )
}
