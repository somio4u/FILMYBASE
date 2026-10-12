// The Auto Screenplay Agent panel — reachable from every stage of every draft (Movie and AI Movie). You type, use the pen, or speak; the
// agent first says what it understood and what it would touch, and nothing is changed, copied or paid for until you press a specific button.

import { useCallback, useEffect, useRef, useState } from 'react'
import './Drafts.css'

async function call(url, method = 'GET', body) {
  try {
    const r = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } }
  }
}
const INTENT_LABEL = { LOCAL_EDIT: 'Edit a selected piece', SCOPED_REWRITE: 'Rewrite several pieces', NEW_DRAFT: 'Create a new draft', ALTERNATIVE: 'Explore an alternative', NEW_STORY: 'Start a new story', CONTINUE: 'Continue the draft', UNCLEAR: 'Not sure yet' }
// story fields can arrive as plain text or as {en, hi} style objects; always draw text, never an object
const txt = (v) => {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(txt).filter(Boolean).join(', ')
  if (typeof v === 'object') return txt(v.en ?? v.text ?? v.problem ?? v.title ?? Object.values(v)[0])
  return ''
}

const REQUEST_LABEL = { analyzing: 'Reading the whole draft and designing the new story…', awaiting_synopsis_approval: 'Waiting for your approval of the new Story Bible', synopsis_approved: 'Story Bible approved', rewriting: 'Writing the new draft with the story process…', awaiting_final_approval: 'Waiting for your final approval', completed: 'Completed', cancelled: 'Cancelled', failed: 'Stopped — can be retried' }

function Diff({ edit }) {
  return (
    <li className="da-edit">
      <strong>{edit.label}</strong>
      <div className="dd-sides"><div><h5>Before</h5><pre>{edit.beforeText}</pre></div><div><h5>After</h5><pre>{edit.afterText}</pre></div></div>
    </li>
  )
}

function Revision({ requestId, backendUrl, onOpenDraft, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const r = await call(`${backendUrl}/api/drafts/requests/${requestId}`)
    if (r.ok) setData(r.data); else setError(r.data.error)
  }, [backendUrl, requestId])
  useEffect(() => { load() }, [load])
  const status = data?.request?.status
  useEffect(() => {
    if (!['analyzing', 'rewriting', 'synopsis_approved'].includes(status)) return undefined
    const t = setInterval(load, 2500)
    return () => clearInterval(t)
  }, [status, load])
  if (!data) return <p className="dd-note">{error ?? 'Loading the revision…'}</p>
  const r = data.request
  const post = async (path, body = {}) => {
    if (busy) return
    setBusy(true); setError(null)
    const res = await call(`${backendUrl}/api/drafts/requests/${requestId}/${path}`, 'POST', { expectedRevision: r.revision, ...body })
    setBusy(false)
    if (!res.ok) setError(res.data.error ?? 'That did not work.')
    await load(); onChanged?.()
  }
  const impact = r.impactMap
  const label = (k) => data.comparison?.rows?.find((x) => x.key === k)?.label ?? k
  return (
    <section className="da-revision" aria-label="Revision review">
      <h3>{data.draft?.title ?? 'New draft'} <span className="chip">{REQUEST_LABEL[status] ?? status}</span></h3>
      <p className="dd-fine">From {data.parentDraft?.title}. Your instruction (kept exactly): “{r.instruction}” {r.source === 'mic' ? '· spoken' : ''}</p>
      {r.constraints?.mustKeep?.length > 0 && <p className="dd-fine">Must keep: {r.constraints.mustKeep.join('; ')}</p>}
      {r.constraints?.mustChange?.length > 0 && <p className="dd-fine">Must change: {r.constraints.mustChange.join('; ')}</p>}
      {['analyzing', 'rewriting', 'synopsis_approved', 'awaiting_synopsis_approval', 'awaiting_final_approval'].includes(status) && (
        <p className="dd-fine da-where">Where it is saved: the finished script appears in <strong>Drafts</strong> for this project as <strong>{data.draft?.title ?? 'the next draft number'}</strong>{data.draft ? '' : ' (it shows up there when the writing finishes)'}. Nothing here is deleted.</p>
      )}
      {error && <p className="dd-error" role="alert">{error}</p>}
      {r.error && status === 'failed' && <p className="dd-error" role="alert">{r.error}</p>}
      {impact && (
        <details open={status === 'awaiting_synopsis_approval'} className="da-impact">
          <summary>Revision Impact Map — {impact.counts?.unchanged ?? 0} unchanged · {impact.counts?.modified ?? 0} modified · {impact.counts?.indirect ?? 0} indirectly affected · {impact.counts?.added ?? 0} new · {impact.counts?.removed ?? 0} removed</summary>
          <ul>
            {(impact.modified ?? []).map((x) => <li key={x.key}><span className="chip modified">modified</span> {label(x.key)} — {txt(x.why)}</li>)}
            {(impact.indirect ?? []).map((x) => <li key={x.key}><span className="chip">affected</span> {label(x.key)} — {txt(x.why)}</li>)}
            {(impact.added ?? []).map((x, i) => <li key={`a${i}`}><span className="chip added">new</span> {txt(x.label)} — {txt(x.why)}</li>)}
            {(impact.removed ?? []).map((x) => <li key={x.key}><span className="chip removed">removed</span> {label(x.key)} — {txt(x.why)}</li>)}
          </ul>
        </details>
      )}
      {r.proposal && (
        <div className="da-proposal">
          <h4>New Story Bible — {txt(r.proposal.title)}</h4>
          {r.proposal.logline && <p className="da-synopsis">{txt(r.proposal.logline)}</p>}
          {r.proposal.centralQuestion && <p className="dd-fine">Central question: {txt(r.proposal.centralQuestion)}</p>}
          {r.proposal.critics?.scores && (
            <p>Critics' scores: {Object.entries(r.proposal.critics.scores).map(([k, v]) => <span key={k} className={`chip ${v >= (r.proposal.critics.passScore ?? 8) ? 'modified' : 'removed'}`}>{k} {txt(v)}/10</span>)} {r.proposal.critics.passed ? '— passed' : `— below ${r.proposal.critics.passScore ?? 8}; you can ask for changes`}</p>
          )}
          {(r.proposal.critics?.open ?? []).length > 0 && <><h5>Open problems the critics still see</h5><ul>{r.proposal.critics.open.map((o, i) => <li key={i}>{txt(o)}</li>)}</ul></>}
        </div>
      )}
      {status === 'awaiting_synopsis_approval' && (
        <div className="da-gate">
          <p><strong>Nothing has been written yet.</strong> Approving starts the normal story process (judges score every stage, weak ones are redone toward 8–9) and writes the new draft. {data.parentDraft?.title} is never changed.</p>
          <div className="dd-actions">
            <button type="button" className="dd-btn primary" disabled={busy} onClick={() => post('synopsis/approve')}>Approve Story &amp; Write New Draft</button>
            <button type="button" className="dd-btn" disabled={busy} onClick={() => { if (window.confirm('Cancel this revision? The new draft is archived (kept for the record).')) post('cancel') }}>Cancel</button>
          </div>
          <label className="da-feedback">Request changes to the story<textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="For example: make the villain her mentor instead." /></label>
          <button type="button" className="dd-btn" disabled={busy || !feedback.trim()} onClick={async () => { await post('synopsis/changes', { feedback }); setFeedback('') }}>Request Changes</button>
        </div>
      )}
      {(status === 'rewriting' || status === 'awaiting_final_approval' || status === 'completed') && (r.progress ?? []).length > 0 && (
        <ul className="da-progress" aria-label="Rewrite progress">{r.progress.map((p) => <li key={p.key}><span className={`chip ${p.reachedTarget === false ? 'removed' : p.status === 'done' ? 'modified' : ''}`}>{p.score != null ? `${p.score}/10` : p.status}</span> {String(p.key).replace('stage:', '').replace('beat:', 'screenplay part ')}{p.attempts > 1 ? ` — ${p.attempts} tries` : ''}{p.reachedTarget === false ? ' — below 8, best version kept' : ''}</li>)}</ul>
      )}
      {status === 'failed' && <button type="button" className="dd-btn primary" disabled={busy} onClick={() => post('retry')}>Retry (finished pieces are kept)</button>}
      {status === 'awaiting_final_approval' && (
        <div className="da-gate">
          {data.comparison && <p>Compared with {data.parentDraft?.title}: <span className="chip preserved">{data.comparison.counts.preserved} preserved</span> <span className="chip modified">{data.comparison.counts.modified} modified</span> <span className="chip added">{data.comparison.counts.added} added</span> <span className="chip removed">{data.comparison.counts.removed} removed</span></p>}
          {(impact?.manual ?? []).length > 0 && <p className="dd-flag">Needs your hand: {impact.manual.join(' · ')}</p>}
          <p className="dd-fine">Every stage was judged by the normal process; the scores above are the judges' own.</p>
          <div className="dd-actions">
            <button type="button" className="dd-btn primary" disabled={busy} onClick={() => post('approve')}>Approve Revised Draft</button>
            <button type="button" className="dd-btn" onClick={() => onOpenDraft?.('compare')}>Compare with Parent</button>
            <button type="button" className="dd-btn" onClick={() => onOpenDraft?.('open')}>Open the new draft</button>
          </div>
        </div>
      )}
      {status === 'completed' && <button type="button" className="dd-btn primary" onClick={() => onOpenDraft?.('open')}>Open the new draft</button>}
      <button type="button" className="dd-btn" onClick={onClose}>Back</button>
    </section>
  )
}

export default function DraftAgentPanel({ backendUrl, draft, getContext, InputComponent, onClose, onOpenDraft, onApplied, initialRequestId = null, initialSelection = '', embedded = false }) {
  const api = `${backendUrl}/api/drafts/${draft.id}`
  const [text, setText] = useState('')
  const [source, setSource] = useState('pen')
  const [selection] = useState(initialSelection)
  const [interp, setInterp] = useState(null)
  const [picked, setPicked] = useState([])
  const [cs, setCs] = useState(null)
  const [alt, setAlt] = useState(null)
  const [requestId, setRequestId] = useState(initialRequestId)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [story, setStory] = useState({ destination: 'same_project', idea: '' })
  const ctxRef = useRef(null)
  const context = () => ({ ...(getContext?.() ?? {}), selectedText: selection || undefined })

  async function run(label, fn) {
    if (busy) return null
    setBusy(label); setError(null); setNote(null)
    const r = await fn()
    setBusy('')
    if (!r.ok) { setError(r.data.error ?? 'That did not work.'); return null }
    return r.data
  }
  const interpret = async () => {
    ctxRef.current = context()
    const d = await run('interpret', () => call(`${api}/agent/interpret`, 'POST', { instruction: text, source, context: ctxRef.current }))
    if (d) { setInterp(d); setPicked(d.targets.map((t) => t.key)); setCs(null); setAlt(null) }
  }
  const body = () => ({ instruction: text, intent: interp.intent, targetKeys: picked, context: ctxRef.current ?? context(), constraints: interp.constraints, confirmed: true })
  const confirmEdit = draft.status === 'approved'

  const asEdit = interp && ['LOCAL_EDIT', 'SCOPED_REWRITE'].includes(interp.intent)
  return (
    <aside className={embedded ? 'da da-embedded' : 'da'} aria-label="Auto Screenplay Agent">
      <header className="da-head">
        <div>
          {!embedded && <h2>Auto Screenplay Agent</h2>}
          <p className="da-crumbs" aria-label="Where you are">{draft.title} · {draft.module === 'film' ? 'Movie' : 'AI Movie'} · {getContext?.()?.stageLabel ?? 'current stage'}{selection ? ' · text selected' : ''}</p>
        </div>
        {embedded
          ? <button type="button" className="dd-btn" onClick={() => onOpenDraft?.('dashboard')}>All drafts</button>
          : <button type="button" className="dd-btn" onClick={onClose} aria-label="Close agent">×</button>}
      </header>
      {requestId ? (
        <Revision requestId={requestId} backendUrl={backendUrl} onClose={() => setRequestId(null)} onChanged={onApplied} onOpenDraft={(what) => onOpenDraft?.(what, requestId)} />
      ) : (
        <>
          {selection && <p className="da-selection">Selected: “{selection.slice(0, 160)}{selection.length > 160 ? '…' : ''}”</p>}
          <label className="da-ask">What should the agent do? {source === 'mic' ? <span className="chip">spoken — check the words before continuing</span> : null}
            {InputComponent
              ? <InputComponent rows={3} value={text} onChange={(e) => { setText(e.target.value); setSource(e.nativeEvent ? 'pen' : 'mic'); setInterp(null) }} placeholder="Rewrite this dialogue to feel more threatening… / Create a second draft where the villain is her brother… / Try an ending where the hero loses…" />
              : <textarea rows={3} value={text} onChange={(e) => { setText(e.target.value); setInterp(null) }} />}
          </label>
          <div className="dd-actions"><button type="button" className="dd-btn primary" disabled={!text.trim() || Boolean(busy)} onClick={interpret}>{busy === 'interpret' ? 'Reading…' : 'Understand this'}</button></div>
          {error && <p className="dd-error" role="alert">{error}</p>}
          {note && <p className="dd-note" role="status">{note}</p>}

          {interp && (
            <section className="da-interp" aria-label="What the agent understood">
              <h3>{INTENT_LABEL[interp.intent]} <span className="chip">{Math.round(interp.confidence * 100)}% sure</span></h3>
              <p>{interp.summary}</p>
              <p className="dd-fine">Nothing has been changed yet.{interp.usedModel ? '' : ' (The AI was unavailable, so this was read from your words only.)'}</p>
              {interp.draft.message && <p className="dd-error" role="alert">{interp.draft.message}</p>}
              {interp.constraints.mustKeep.length > 0 && <p className="dd-fine">Keep: {interp.constraints.mustKeep.join('; ')}</p>}
              {interp.constraints.mustChange.length > 0 && <p className="dd-fine">Change: {interp.constraints.mustChange.join('; ')}</p>}
              {interp.unresolved.map((u, i) => <p key={i} className="dd-flag">{txt(u.why)}</p>)}
              {(interp.candidates?.length > 0 || asEdit) && (
                <details open={interp.candidates?.length > 0} className="da-picker">
                  <summary>{picked.length} piece{picked.length === 1 ? '' : 's'} chosen — change the choice</summary>
                  <ul>{(interp.candidates?.length ? interp.candidates : interp.targets.map((t, i) => ({ key: t.key, number: i + 1, label: t.label }))).map((c) => (
                    <li key={c.key}><label><input type="checkbox" checked={picked.includes(c.key)} onChange={() => setPicked((p) => (p.includes(c.key) ? p.filter((k) => k !== c.key) : [...p, c.key]))} /> {c.label}</label></li>
                  ))}</ul>
                </details>
              )}
              {interp.estimate.modelCalls > 0 && <p className="dd-fine">About {interp.estimate.modelCalls} AI call{interp.estimate.modelCalls === 1 ? '' : 's'} (≈ ${interp.estimate.usd.toFixed(2)}). {interp.estimate.note}</p>}

              {interp.needsClarification && interp.unresolved.length === 0 && <p className="dd-flag">I am not sure what you want. Choose one:</p>}
              <div className="dd-actions">
                {(interp.needsClarification && interp.unresolved.length === 0 ? interp.allChoices : []).map((c) => (
                  <button key={c.action} type="button" className="dd-btn" onClick={() => setInterp({ ...interp, intent: c.intent, needsClarification: false, options: [c] })}>{c.label}</button>
                ))}
                {asEdit && !interp.needsClarification && interp.draft.editable && (
                  <button type="button" className="dd-btn primary" disabled={!picked.length || Boolean(busy)} onClick={async () => { const d = await run('propose', () => call(`${api}/agent/propose`, 'POST', body())); if (d) setCs(d.changeSet) }}>{busy === 'propose' ? 'Preparing…' : 'Preview the changes'}</button>
                )}
                {asEdit && interp.needsClarification && picked.length > 0 && interp.unresolved.length > 0 && (
                  <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => { const d = await run('propose', () => call(`${api}/agent/propose`, 'POST', body())); if (d) setCs(d.changeSet) }}>Preview these pieces</button>
                )}
                {interp.intent === 'ALTERNATIVE' && !interp.needsClarification && (
                  <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => { const d = await run('alt', () => call(`${api}/agent/alternative`, 'POST', body())); if (d) setAlt(d) }}>{busy === 'alt' ? 'Creating…' : 'Create an alternative and preview it there'}</button>
                )}
                {interp.intent === 'NEW_DRAFT' && (
                  <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => { const d = await run('rev', () => call(`${api}/agent/revision`, 'POST', { instruction: text, source, context: ctxRef.current ?? context(), constraints: interp.constraints, confirmed: true })); if (d) { setRequestId(d.request.id); onApplied?.() } }}>{busy === 'rev' ? 'Creating the new draft…' : 'Create the new draft and analyse'}</button>
                )}
                {interp.intent === 'CONTINUE' && (
                  <button type="button" className="dd-btn primary" onClick={() => onOpenDraft?.('continue')}>Continue this draft where it stopped</button>
                )}
              </div>
              {interp.intent === 'NEW_DRAFT' && <p className="dd-fine">This makes a COPY as the next draft and analyses the whole screenplay. It stops at the revised synopsis for your approval before any scene is rewritten.</p>}

              {interp.intent === 'NEW_STORY' && !interp.needsClarification && (
                <div className="da-newstory">
                  <label><input type="radio" name="dest" checked={story.destination === 'same_project'} onChange={() => setStory({ ...story, destination: 'same_project' })} /> A new draft in this project (appears on the Drafts list)</label>
                  <label><input type="radio" name="dest" checked={story.destination === 'new_project'} onChange={() => setStory({ ...story, destination: 'new_project' })} /> A separate new project</label>
                  <textarea rows={2} value={story.idea} onChange={(e) => setStory({ ...story, idea: e.target.value })} placeholder="The new story idea…" />
                  <button type="button" className="dd-btn primary" disabled={!story.idea.trim() || Boolean(busy)} onClick={async () => { const d = await run('story', () => call(`${api}/agent/new-story`, 'POST', story)); if (d) { setNote('Created. Opening it…'); onOpenDraft?.('open-new', d) } }}>Create it</button>
                </div>
              )}
            </section>
          )}

          {cs && (
            <section className="da-preview" aria-label="Preview of the changes">
              <h3>Preview — {cs.changes} piece{cs.changes === 1 ? '' : 's'} would change {cs.status === 'applied' ? '(applied)' : cs.status === 'undone' ? '(undone)' : ''}</h3>
              {cs.failures?.map((f, i) => <p key={i} className="dd-flag">{f.key}: {f.message}</p>)}
              {cs.changes === 0 && <p className="dd-note">The AI did not change anything.</p>}
              <ul className="da-edits">{cs.edits.map((e) => <Diff key={e.key} edit={e} />)}</ul>
              <div className="dd-actions">
                {cs.status === 'proposed' && cs.changes > 0 && <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => {
                  if (confirmEdit && !window.confirm('This draft is approved. Edit it anyway? (A new draft keeps it safe.)')) return
                  const d = await run('apply', () => call(`${backendUrl}/api/drafts/change-sets/${cs.id}/apply`, 'POST', { confirmEditApproved: confirmEdit })); if (d) { setCs(d.changeSet); onApplied?.() }
                }}>Apply to this draft</button>}
                {cs.status === 'proposed' && <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={async () => { const d = await run('reject', () => call(`${backendUrl}/api/drafts/change-sets/${cs.id}/reject`, 'POST', {})); if (d) setCs(null) }}>Discard</button>}
                {cs.status === 'applied' && <button type="button" className="dd-btn" disabled={Boolean(busy)} onClick={async () => { const d = await run('undo', () => call(`${backendUrl}/api/drafts/change-sets/${cs.id}/undo`, 'POST', {})); if (d) { setCs(d.changeSet); onApplied?.() } }}>Undo</button>}
              </div>
            </section>
          )}
          {alt && (
            <section className="da-preview" aria-label="Alternative">
              <h3>Alternative created: {alt.alternative.label ?? 'Alternative'}</h3>
              <p className="dd-fine">It is a separate copy with no draft number. The original is unchanged. Open the Drafts list to continue in it, or promote it to a numbered draft.</p>
              {alt.error && <p className="dd-error">{alt.error}</p>}
              {alt.changeSet && <ul className="da-edits">{alt.changeSet.edits.map((e) => <Diff key={e.key} edit={e} />)}</ul>}
              <div className="dd-actions">
                {alt.changeSet?.status === 'proposed' && <button type="button" className="dd-btn primary" disabled={Boolean(busy)} onClick={async () => { const d = await run('apply', () => call(`${backendUrl}/api/drafts/change-sets/${alt.changeSet.id}/apply`, 'POST', { confirmEditApproved: true })); if (d) setAlt({ ...alt, changeSet: d.changeSet }) }}>Apply inside the alternative</button>}
                <button type="button" className="dd-btn" onClick={() => onOpenDraft?.('dashboard')}>Open the Drafts list</button>
              </div>
            </section>
          )}
        </>
      )}
    </aside>
  )
}
