import { useCallback, useEffect, useRef, useState } from 'react'
import './BuddyChat.css'

// The Buddy: a chat friend opened from the voice orb in the screenplay screen. It remembers the conversation (kept on the server per person and
// project, so it is still here after a reload), knows the app and sees the scene you are on. Type, or press the mic and speak.
// Step 1: it talks — it answers, explains and drafts suggestions; it does not change the screenplay yet.
const TEXT = {
  en: {
    title: 'Buddy', sub: (n) => (n ? `looking at scene ${n}` : 'your writing friend'),
    hint: 'Ask me anything — about this scene, your story, or how to do something in the app.',
    placeholder: 'Type here, or press the mic and speak…',
    send: 'Send', thinking: 'Buddy is thinking', newChat: 'New chat', closeLabel: 'Close',
    confirmNew: 'Start a new conversation? The Buddy will forget this one.', autoSend: 'Send when I stop speaking',
    loadFail: 'Could not load the earlier conversation.', failed: 'The Buddy could not answer.', retryNote: 'Your message is back in the box — press Send to try again.',
    notYet: 'Right now I can talk and suggest, but I cannot change the screenplay for you yet.',
    starters: ['How long is this scene?', 'What can you help me with?', 'How do I make this scene longer?'],
  },
  or: {
    title: 'ବଡ଼ି', sub: (n) => (n ? `ସିନ୍ ${n} ଦେଖୁଛି` : 'ତୁମ ଲେଖାର ସାଙ୍ଗ'),
    hint: 'ମତେ ଯାହା ପଚାର — ଏହି ସିନ୍, ତୁମ ଗପ, କିମ୍ବା ଆପ୍‌ରେ କିଛି କେମିତି କରିବ।',
    placeholder: 'ଏଠି ଲେଖ, କିମ୍ବା ମାଇକ୍ ଦବାଇ କୁହ…',
    send: 'ପଠାଅ', thinking: 'ବଡ଼ି ଭାବୁଛି', newChat: 'ନୂଆ ଚାଟ୍', closeLabel: 'ବନ୍ଦ',
    confirmNew: 'ନୂଆ କଥାବାର୍ତ୍ତା ଆରମ୍ଭ କରିବ? ବଡ଼ି ଏହାକୁ ଭୁଲିଯିବ।', autoSend: 'କହିବା ସରିଲେ ନିଜେ ପଠାଅ',
    loadFail: 'ଆଗର କଥାବାର୍ତ୍ତା ଆଣିହେଲା ନାହିଁ।', failed: 'ବଡ଼ି ଉତ୍ତର ଦେଇପାରିଲା ନାହିଁ।', retryNote: 'ତୁମ ମେସେଜ୍ ବକ୍ସରେ ଫେରିଆସିଲା — ପୁଣି ପଠାଅ।',
    notYet: 'ବର୍ତ୍ତମାନ ମୁଁ କହିପାରିବି ଓ ପରାମର୍ଶ ଦେଇପାରିବି, ମାତ୍ର ତୁମ ପାଇଁ ସ୍କ୍ରିନ୍‌ପ୍ଲେ ବଦଳେଇ ପାରିବି ନାହିଁ।',
    starters: ['ଏହି ସିନ୍ କେତେ ମିନିଟ୍‌ର?', 'ତୁମେ କେଉଁ କାମରେ ସାହାଯ୍ୟ କରିପାରିବ?', 'ଏହି ସିନ୍‌କୁ କେମିତି ଲମ୍ବା କରିବି?'],
  },
}

export default function BuddyChat({ backendUrl, sceneListId, episodeIndex, sceneIndex, sceneNumber, lang = 'en', onClose, renderMic }) {
  const L = TEXT[lang] ?? TEXT.en
  const [messages, setMessages] = useState([]) // [{ id, role: 'user' | 'assistant', content, local? }]
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(null) // { startedAt } while the Buddy is thinking
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const [autoSend, setAutoSend] = useState(() => { try { return localStorage.getItem('filmybase:buddyAutoSend') !== '0' } catch { return true } })
  const listRef = useRef(null)
  const alive = useRef(true)
  const base = `${backendUrl}/api/assistant/${sceneListId}`

  useEffect(() => {
    alive.current = true
    setLoading(true)
    fetch(`${base}/history`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => { if (alive.current) { if (ok) setMessages(d.messages ?? []); else setError(d.error || L.loadFail) } })
      .catch(() => { if (alive.current) setError(L.loadFail) })
      .finally(() => { if (alive.current) setLoading(false) })
    return () => { alive.current = false }
  }, [base]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, sending])
  useEffect(() => {
    if (!sending) return undefined
    const id = setInterval(() => setSeconds(Math.round((Date.now() - sending.startedAt) / 1000)), 500)
    return () => clearInterval(id)
  }, [sending])

  const send = useCallback(async (raw) => {
    const message = String(raw ?? '').trim()
    if (!message || sending) return
    setError('')
    setText('')
    const temp = { id: `local-${Date.now()}`, role: 'user', content: message, local: true }
    setMessages((m) => [...m, temp])
    setSending({ startedAt: Date.now() })
    setSeconds(0)
    try {
      const response = await fetch(`${base}/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message, episodeIndex, sceneIndex }),
      })
      const data = await response.json().catch(() => ({}))
      if (!alive.current) return
      if (!response.ok) throw new Error(data.error || `${L.failed} (HTTP ${response.status})`)
      setMessages((m) => [...m.filter((x) => x.id !== temp.id), data.userMessage, data.assistantMessage])
    } catch (e) {
      if (!alive.current) return
      setMessages((m) => m.filter((x) => x.id !== temp.id)) // the question got no answer: it goes back into the box
      setText(message)
      setError(`${e.message || L.failed} — ${L.retryNote}`)
    } finally { if (alive.current) setSending(null) }
  }, [base, episodeIndex, sceneIndex, sending, L.failed, L.retryNote])

  async function newChat() {
    if (!window.confirm(L.confirmNew)) return
    try { await fetch(`${base}/history`, { method: 'DELETE' }) } catch { /* the screen is cleared anyway */ }
    setMessages([]); setError('')
  }

  const spoken = (words) => { if (autoSend) send(words); else setText((t) => (t.trim() ? `${t.trim()} ${words}` : words)) }

  return (
    <section className="buddy-panel" role="dialog" aria-label={L.title}>
      <header className="buddy-head">
        <div><strong>💬 {L.title}</strong><small>{L.sub(sceneNumber)}</small></div>
        <div className="buddy-head-actions">
          {messages.length > 0 && <button type="button" onClick={newChat} className="buddy-link">{L.newChat}</button>}
          <button type="button" onClick={onClose} aria-label={L.closeLabel} className="buddy-x">✕</button>
        </div>
      </header>

      <div className="buddy-list" ref={listRef} aria-live="polite">
        {loading && <p className="buddy-note">…</p>}
        {!loading && messages.length === 0 && (
          <div className="buddy-empty">
            <p>{L.hint}</p>
            <div className="buddy-starters">
              {L.starters.map((s) => <button type="button" key={s} onClick={() => send(s)}>{s}</button>)}
            </div>
            <p className="buddy-note">{L.notYet}</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`buddy-msg is-${m.role}${m.local ? ' is-local' : ''}`}><p>{m.content}</p></div>
        ))}
        {sending && <div className="buddy-msg is-assistant is-thinking"><p>⏳ {L.thinking}… <b>{seconds}s</b></p></div>}
      </div>

      {error && <p className="buddy-error" role="alert">{error}</p>}

      <form className="buddy-input" onSubmit={(e) => { e.preventDefault(); send(text) }}>
        <textarea
          value={text} rows={2} placeholder={L.placeholder} disabled={Boolean(sending)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text) } }}
        />
        <div className="buddy-input-row">
          <label className="buddy-auto">
            <input type="checkbox" checked={autoSend} onChange={(e) => { setAutoSend(e.target.checked); try { localStorage.setItem('filmybase:buddyAutoSend', e.target.checked ? '1' : '0') } catch { /* fine */ } }} />
            {L.autoSend}
          </label>
          {renderMic?.(spoken)}
          <button type="submit" className="buddy-send" disabled={Boolean(sending) || !text.trim()}>{L.send}</button>
        </div>
      </form>
    </section>
  )
}
