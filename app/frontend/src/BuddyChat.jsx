import { useCallback, useEffect, useRef, useState } from 'react'
import './BuddyChat.css'

// The Buddy: a chat friend opened from the voice orb in the screenplay screen. It remembers the conversation (kept on the server per person and
// project, so it is still here after a reload), knows the app and sees the scene you are on. Type, or press the mic and speak.
// It answers, explains and drafts. When it proposes a change to the scene on screen, a card with Apply / No thanks appears under its message;
// only Apply changes the screenplay (the same machine as the 🎙 voice edit, so Undo, edit-draft and the progress panel all work).
const TEXT = {
  en: {
    title: 'Buddy', sub: (n) => (n ? `looking at scene ${n}` : 'your writing friend'),
    hint: 'Ask me anything — about this scene, your story, or how to do something in the app.',
    placeholder: 'Type here, or press the mic and speak…',
    send: 'Send', thinking: 'Buddy is thinking', newChat: 'New chat', closeLabel: 'Close',
    confirmNew: 'Start a new conversation? The Buddy will forget this one.', autoSend: 'Send when I stop speaking',
    listen: 'Listen', stopListen: 'Stop', readAloud: 'Read replies aloud', noVoice: 'This device has no Odia voice, so it cannot read Odia aloud. (Phones with Google text-to-speech and the Odia language pack installed usually can.) You can still read the replies.', speakFail: 'Could not read this aloud.',
    loadFail: 'Could not load the earlier conversation.', failed: 'The Buddy could not answer.', retryNote: 'Your message is back in the box — press Send to try again.',
    notYet: 'I can also change the scene for you: tell me what you want, and I will show it first — nothing changes until you press Apply.',
    proposes: 'Proposed change', older: 'An older suggestion — ask again if you still want it.', apply: '✓ Apply', dismiss: 'No thanks', applying: 'Applying…', applied: 'Applied', dismissed: 'Skipped', otherScene: (n) => `This was for scene ${n}. Open that scene to apply it.`, busyNote: 'Another change is running — wait for it.',
    starters: ['How long is this scene?', 'What can you help me with?', 'How do I make this scene longer?'],
  },
  or: {
    title: 'ବଡ଼ି', sub: (n) => (n ? `ସିନ୍ ${n} ଦେଖୁଛି` : 'ତୁମ ଲେଖାର ସାଙ୍ଗ'),
    hint: 'ମତେ ଯାହା ପଚାର — ଏହି ସିନ୍, ତୁମ ଗପ, କିମ୍ବା ଆପ୍‌ରେ କିଛି କେମିତି କରିବ।',
    placeholder: 'ଏଠି ଲେଖ, କିମ୍ବା ମାଇକ୍ ଦବାଇ କୁହ…',
    send: 'ପଠାଅ', thinking: 'ବଡ଼ି ଭାବୁଛି', newChat: 'ନୂଆ ଚାଟ୍', closeLabel: 'ବନ୍ଦ',
    confirmNew: 'ନୂଆ କଥାବାର୍ତ୍ତା ଆରମ୍ଭ କରିବ? ବଡ଼ି ଏହାକୁ ଭୁଲିଯିବ।', autoSend: 'କହିବା ସରିଲେ ନିଜେ ପଠାଅ',
    listen: 'ଶୁଣ', stopListen: 'ବନ୍ଦ', readAloud: 'ଉତ୍ତର ପଢ଼ି ଶୁଣାଅ', noVoice: 'ଏହି ଡିଭାଇସ୍‌ରେ ଓଡ଼ିଆ ଅଵାଜ୍ ନାହିଁ, ତେଣୁ ଓଡ଼ିଆ ପଢ଼ି ଶୁଣାଇପାରିବ ନାହିଁ। (ଯେଉଁ ଫୋନ୍‌ରେ Google text-to-speech ଓ ଓଡ଼ିଆ ଭାଷା ପ୍ୟାକ୍ ଅଛି ସେଥିରେ ସାଧାରଣତଃ ହୁଏ।) ଉତ୍ତର ତ ପଢ଼ିପାରିବ।', speakFail: 'ଏହାକୁ ପଢ଼ି ଶୁଣାଇ ହେଲା ନାହିଁ।',
    loadFail: 'ଆଗର କଥାବାର୍ତ୍ତା ଆଣିହେଲା ନାହିଁ।', failed: 'ବଡ଼ି ଉତ୍ତର ଦେଇପାରିଲା ନାହିଁ।', retryNote: 'ତୁମ ମେସେଜ୍ ବକ୍ସରେ ଫେରିଆସିଲା — ପୁଣି ପଠାଅ।',
    notYet: 'ମୁଁ ସିନ୍ ବଦଳେଇ ବି ପାରିବି: କୁହ କଣ ଚାହୁଁ, ମୁଁ ପ୍ରଥମେ ଦେଖେଇବି — Apply ଦବେଇଲେ ହିଁ ବଦଳିବ।',
    proposes: 'ପ୍ରସ୍ତାବିତ ବଦଳ', older: 'ପୁରୁଣା ପ୍ରସ୍ତାବ — ଦରକାର ହେଲେ ପୁଣି କୁହ।', apply: '✓ Apply', dismiss: 'ଦରକାର ନାହିଁ', applying: 'ଲାଗୁଛି…', applied: 'ଲାଗିଗଲା', dismissed: 'ଛାଡ଼ିଦେଲା', otherScene: (n) => `ଏହା ସିନ୍ ${n} ପାଇଁ ଥିଲା। ସେହି ସିନ୍ ଖୋଲି Apply କର।`, busyNote: 'ଆଉ ଗୋଟେ ବଦଳ ଚାଲିଛି — ଅପେକ୍ଷା କର।',
    starters: ['ଏହି ସିନ୍ କେତେ ମିନିଟ୍‌ର?', 'ତୁମେ କେଉଁ କାମରେ ସାହାଯ୍ୟ କରିପାରିବ?', 'ଏହି ସିନ୍‌କୁ କେମିତି ଲମ୍ବା କରିବି?'],
  },
}

// Reading a reply aloud with the device's own voice (the browser's speech synthesis — free, nothing is sent anywhere). Odia voices are rare, so the
// voices are looked up first; with none, the person is told plainly instead of hearing garbage.
const speechApi = () => (typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined' ? window.speechSynthesis : null)
const spokenForm = (text) => String(text ?? '').replace(/\[\[[\s\S]*?\]\]/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
function findOdiaVoice() {
  const api = speechApi()
  if (!api) return null
  return api.getVoices().find((v) => /^or([-_]|$)/i.test(v.lang)) ?? null
}

export default function BuddyChat({ backendUrl, sceneListId, episodeIndex, sceneIndex, sceneNumber, lang = 'en', onClose, renderMic, onApplyEdit, busy = false }) {
  const L = TEXT[lang] ?? TEXT.en
  const [messages, setMessages] = useState([]) // [{ id, role: 'user' | 'assistant', content, local? }]
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(null) // { startedAt } while the Buddy is thinking
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const [autoSend, setAutoSend] = useState(() => { try { return localStorage.getItem('filmybase:buddyAutoSend') !== '0' } catch { return true } })
  const [readAloud, setReadAloud] = useState(() => { try { return localStorage.getItem('filmybase:buddyReadAloud') === '1' } catch { return false } })
  const [speakingId, setSpeakingId] = useState(null)
  const readAloudRef = useRef(readAloud)
  const speakRef = useRef(null)
  const [voiceNote, setVoiceNote] = useState('')
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
      if (readAloudRef.current && data.assistantMessage?.content) speakRef.current?.(data.assistantMessage)
    } catch (e) {
      if (!alive.current) return
      setMessages((m) => m.filter((x) => x.id !== temp.id)) // the question got no answer: it goes back into the box
      setText(message)
      setError(`${e.message || L.failed} — ${L.retryNote}`)
    } finally { if (alive.current) setSending(null) }
  }, [base, episodeIndex, sceneIndex, sending, L.failed, L.retryNote])

  const stopSpeaking = useCallback(() => { try { speechApi()?.cancel() } catch { /* nothing is speaking */ } setSpeakingId(null) }, [])
  const speak = useCallback((message) => {
    const api = speechApi()
    if (!api) { setVoiceNote(L.noVoice); return }
    const voice = findOdiaVoice()
    if (!voice) { setVoiceNote(L.noVoice); return }
    setVoiceNote('')
    api.cancel()
    const utterance = new window.SpeechSynthesisUtterance(spokenForm(message.content))
    utterance.voice = voice
    utterance.lang = voice.lang
    utterance.onend = () => { if (alive.current) setSpeakingId((id) => (id === message.id ? null : id)) }
    utterance.onerror = () => { if (alive.current) { setSpeakingId(null); setVoiceNote(L.speakFail) } }
    setSpeakingId(message.id)
    api.speak(utterance)
  }, [L.noVoice, L.speakFail])
  // voices can arrive a moment after the page loads
  useEffect(() => {
    const api = speechApi()
    if (!api) return undefined
    const warm = () => api.getVoices()
    api.addEventListener?.('voiceschanged', warm)
    return () => { api.removeEventListener?.('voiceschanged', warm); try { api.cancel() } catch { /* nothing */ } }
  }, [])

  // Apply / No thanks on a proposal card. Apply runs the instruction through the voice edit (onApplyEdit), then tells the server it is done
  // and adds the result as a note in the chat.
  const [working, setWorking] = useState(null) // message id being applied
  async function resolve(message, apply) {
    if (working) return
    let note = null
    if (apply) {
      setWorking(message.id)
      try { note = await onApplyEdit?.(message.proposed_action.instruction) } catch { note = null }
      if (!alive.current) return
      setWorking(null)
      if (!note?.ok) { setError(note?.text || L.failed); return } // not applied: the card stays, so they can try again
    }
    setMessages((m) => [...m.map((x) => (x.id === message.id ? { ...x, resolved: true, outcome: apply ? 'applied' : 'dismissed' } : x)),
      ...(note ? [{ id: `note-${Date.now()}`, role: 'assistant', content: note.text, local: true, system: true }] : [])])
    try { await fetch(`${base}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: message.id }) }) } catch { /* it only stops the card from coming back after a reload */ }
  }

  async function newChat() {
    if (!window.confirm(L.confirmNew)) return
    try { await fetch(`${base}/history`, { method: 'DELETE' }) } catch { /* the screen is cleared anyway */ }
    setMessages([]); setError('')
  }

  // only the newest open proposal can be applied; older ones are superseded
  const lastOpenId = [...messages].reverse().find((x) => x.proposed_action?.type === 'scene_edit' && !x.resolved)?.id
  readAloudRef.current = readAloud
  speakRef.current = speak
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
          <div key={m.id} className={`buddy-msg is-${m.role}${m.local && !m.system ? ' is-local' : ''}${m.system ? ' is-note' : ''}`}>
            <p>{m.content}</p>
            {m.role === 'assistant' && !m.system && !m.local && m.content && (
              <button type="button" className="buddy-listen" onClick={() => (speakingId === m.id ? stopSpeaking() : speak(m))}>
                {speakingId === m.id ? `■ ${L.stopListen}` : `🔊 ${L.listen}`}
              </button>
            )}
            {m.proposed_action?.type === 'scene_edit' && (
              <div className="buddy-proposal">
                <small>{L.proposes}</small>
                <blockquote>{m.proposed_action.instruction}</blockquote>
                {m.resolved ? (
                  m.outcome ? <small className="buddy-proposal-done">{m.outcome === 'applied' ? `✓ ${L.applied}` : L.dismissed}</small> : null
                ) : m.id !== lastOpenId ? (
                  <small>{L.older}</small>
                ) : m.proposed_action.sceneIndex !== sceneIndex || (m.proposed_action.episodeIndex ?? null) !== (episodeIndex ?? null) ? (
                  <small>{L.otherScene((m.proposed_action.sceneIndex ?? 0) + 1)}</small>
                ) : (
                  <div className="buddy-proposal-actions">
                    <button type="button" className="buddy-apply" onClick={() => resolve(m, true)} disabled={working !== null || busy}>{working === m.id ? L.applying : L.apply}</button>
                    <button type="button" className="buddy-dismiss" onClick={() => resolve(m, false)} disabled={working !== null}>{L.dismiss}</button>
                    {busy && working === null && <small>{L.busyNote}</small>}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {sending && <div className="buddy-msg is-assistant is-thinking"><p>⏳ {L.thinking}… <b>{seconds}s</b></p></div>}
      </div>

      {voiceNote && <p className="buddy-note buddy-voice-note" role="status">{voiceNote}</p>}
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
          <label className="buddy-auto">
            <input type="checkbox" checked={readAloud} onChange={(e) => { setReadAloud(e.target.checked); if (!e.target.checked) stopSpeaking(); try { localStorage.setItem('filmybase:buddyReadAloud', e.target.checked ? '1' : '0') } catch { /* fine */ } }} />
            {L.readAloud}
          </label>
          {renderMic?.(spoken)}
          <button type="submit" className="buddy-send" disabled={Boolean(sending) || !text.trim()}>{L.send}</button>
        </div>
      </form>
    </section>
  )
}
