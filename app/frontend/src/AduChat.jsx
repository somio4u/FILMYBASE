import { useCallback, useEffect, useRef, useState } from 'react'
import './BuddyChat.css'
import './AduChat.css'

// ADU, the friendly front door of AI Movie (the Buddy's face on top of the Draft Agent's safe machinery). One conversation per person and draft, kept on the
// server; the person writes or speaks, Adu answers in words, or says what it understood and proposes — nothing changes until a card's button is pressed.
// The server side is aduChat.js (/api/ai-movie/assistant/:projectId/...).
const TEXT = {
  en: {
    hint: 'Ask me anything — about your story, the beat you are on, or how to do something here. Tell me what to change and I will show it first.',
    placeholder: 'Type here, or press the mic and speak…',
    send: 'Send', thinking: 'Adu is thinking', newChat: 'New chat', confirmNew: 'Start a new conversation? Adu will forget this one.',
    listen: 'Listen', stopListen: 'Stop', readAloud: 'Read replies aloud', noVoice: 'This device has no voice for this language, so it cannot read the reply aloud.', speakFail: 'The voice could not read this aloud.',
    failed: 'Adu could not answer.', retryNote: 'Your message is back in the box — press Send to try again.', loadFail: 'Could not load the earlier conversation.',
    starters: ['What can you help me with?', 'Write the whole screenplay', 'How long is the beat I am on?'],
    filmStarters: ['What can you help me with?', 'Write all the scenes not written yet', 'Add 5 scenes'],
    proposes: 'Adu proposes', big: 'A bigger change', touches: 'It would touch', allDrafts: 'All drafts',
  },
  hi: {
    hint: 'मुझसे कुछ भी पूछो — अपनी कहानी, जिस beat पर हो उसके बारे में, या यहाँ कुछ कैसे करना है। क्या बदलना है बताओ, मैं पहले दिखाऊँगा।',
    placeholder: 'यहाँ लिखो, या mic दबाकर बोलो…',
    send: 'भेजो', thinking: 'Adu सोच रहा है', newChat: 'नई बातचीत', confirmNew: 'नई बातचीत शुरू करें? Adu इसे भूल जाएगा।',
    listen: 'सुनो', stopListen: 'रोको', readAloud: 'जवाब ज़ोर से पढ़कर सुनाओ', noVoice: 'इस device में इस भाषा की आवाज़ नहीं है, इसलिए जवाब पढ़कर सुनाया नहीं जा सकता।', speakFail: 'आवाज़ इसे पढ़ नहीं पाई।',
    failed: 'Adu जवाब नहीं दे पाया।', retryNote: 'आपका संदेश वापस डिब्बे में है — फिर से कोशिश के लिए भेजो दबाओ।', loadFail: 'पिछली बातचीत नहीं आ सकी।',
    starters: ['तुम किस काम में मेरी मदद कर सकते हो?', 'पूरी screenplay लिखो', 'मैं जिस beat पर हूँ वह कितना लंबा है?'],
    filmStarters: ['तुम किस काम में मेरी मदद कर सकते हो?', 'बाकी सारे scenes लिखो', '5 scenes जोड़ो'],
    proposes: 'Adu का प्रस्ताव', big: 'एक बड़ा बदलाव', touches: 'इसमें छुआ जाएगा', allDrafts: 'सारे drafts',
  },
  or: {
    hint: 'ମତେ ଯାହା ପଚାର — ତୁମ ଗପ, ତୁମେ ଯେଉଁ ବିଟ୍‌ରେ ଅଛ ସେ ବିଷୟରେ, କିମ୍ବା ଏଠି କିଛି କେମିତି କରିବ। କଣ ବଦଳାଇବ କୁହ, ମୁଁ ପ୍ରଥମେ ଦେଖାଇବି।',
    placeholder: 'ଏଠି ଲେଖ, କିମ୍ବା ମାଇକ୍ ଦବାଇ କୁହ…',
    send: 'ପଠାଅ', thinking: 'Adu ଭାବୁଛି', newChat: 'ନୂଆ ଚାଟ୍', confirmNew: 'ନୂଆ କଥାବାର୍ତ୍ତା ଆରମ୍ଭ କରିବ? Adu ଏହାକୁ ଭୁଲିଯିବ।',
    listen: 'ଶୁଣ', stopListen: 'ବନ୍ଦ', readAloud: 'ଉତ୍ତର ପଢ଼ି ଶୁଣାଅ', noVoice: 'ଏହି ଡିଭାଇସ୍‌ରେ ଏହି ଭାଷାର ଅଵାଜ୍ ନାହିଁ, ତେଣୁ ଉତ୍ତର ପଢ଼ି ଶୁଣାଇ ହେବ ନାହିଁ।', speakFail: 'ଅଵାଜ୍ ଏହାକୁ ପଢ଼ିପାରିଲା ନାହିଁ।',
    failed: 'Adu ଉତ୍ତର ଦେଇପାରିଲା ନାହିଁ।', retryNote: 'ତୁମ ବାର୍ତ୍ତା ପୁଣି ବାକ୍ସରେ ଅଛି — ପୁଣି ଚେଷ୍ଟା ପାଇଁ ପଠାଅ ଦବାଅ।', loadFail: 'ଆଗର କଥାବାର୍ତ୍ତା ଆଣିହେଲା ନାହିଁ।',
    starters: ['ତୁମେ କେଉଁ କାମରେ ସାହାଯ୍ୟ କରିପାରିବ?', 'ପୁରା ସ୍କ୍ରିନପ୍ଲେ ଲେଖ', 'ମୁଁ ଯେଉଁ ବିଟ୍‌ରେ ଅଛି ତାହା କେତେ ଲମ୍ବା?'],
    filmStarters: ['ତୁମେ କେଉଁ କାମରେ ସାହାଯ୍ୟ କରିପାରିବ?', 'ବାକି ସବୁ ଦୃଶ୍ୟ ଲେଖ', '5 ଦୃଶ୍ୟ ଯୋଡ଼'],
    proposes: 'Adu ର ପ୍ରସ୍ତାବ', big: 'ଏକ ବଡ଼ ବଦଳ', touches: 'ଏଥିରେ ଛୁଇଁବ', allDrafts: 'ସବୁ ଡ୍ରାଫ୍ଟ',
  },
}

// reading a reply aloud with the device's own voice (free, nothing is sent anywhere); a language with no voice on the device is said plainly
const speechApi = () => (typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined' ? window.speechSynthesis : null)
const spokenForm = (text) => String(text ?? '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
const findVoice = (lang) => speechApi()?.getVoices().find((v) => new RegExp(`^${lang}([-_]|$)`, 'i').test(v.lang)) ?? null

// the proposal under an Adu reply (the buttons come from the cards of the next step)
function ActionNote({ action, L, children }) {
  if (!action || action.type === 'none') return null
  return (
    <div className="buddy-proposal adu-action">
      <small>{action.big ? L.big : L.proposes}</small>
      {action.type === 'agent' && action.targets?.length > 0 && <blockquote><small>{L.touches}:</small> {action.targets.slice(0, 6).map((t) => t.label).join(' · ')}</blockquote>}
      {children}
    </div>
  )
}

export default function AduChat({ backendUrl, projectId, module = 'ai_movie', language = 'en', getContext, selection = '', InputComponent, renderAction = null, onNewMessage = null, onAllDrafts = null, pendingMessage = null, onPendingSent = null }) {
  const lang = language === 'or' || language === 'hi' ? language : 'en'
  const L = TEXT[lang]
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(null)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const [readAloud, setReadAloud] = useState(() => { try { return localStorage.getItem('filmybase:aduReadAloud') === '1' } catch { return false } })
  const [speakingId, setSpeakingId] = useState(null)
  const [voiceNote, setVoiceNote] = useState('')
  const listRef = useRef(null)
  const alive = useRef(true)
  const readAloudRef = useRef(readAloud)
  const speakRef = useRef(null)
  const base = `${backendUrl}/api/${module === 'film' ? 'film' : 'ai-movie'}/assistant/${projectId}`

  useEffect(() => {
    alive.current = true
    setLoading(true); setMessages([]); setError('')
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
    setError(''); setText('')
    const temp = { id: `local-${Date.now()}`, role: 'user', content: message, local: true }
    setMessages((m) => [...m, temp])
    setSending({ startedAt: Date.now() }); setSeconds(0)
    try {
      const ctx = getContext?.() ?? {}
      const context = { stage: ctx.stage, ...(Number.isInteger(ctx.beat) ? { beatIndex: ctx.beat } : {}), ...(Number.isInteger(ctx.scene) ? { sceneIndex: ctx.scene } : {}), ...(selection ? { selectedText: selection } : {}) }
      const response = await fetch(`${base}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message, language: lang, context }) })
      const data = await response.json().catch(() => ({}))
      if (!alive.current) return
      if (!response.ok) throw new Error(data.error || `${L.failed} (HTTP ${response.status})`)
      setMessages((m) => [...m.filter((x) => x.id !== temp.id), { ...data.user }, { ...data.assistant, draftId: data.draftId }])
      onNewMessage?.(data)
      if (readAloudRef.current && data.assistant?.content) speakRef.current?.(data.assistant)
    } catch (e) {
      if (!alive.current) return
      setMessages((m) => m.filter((x) => x.id !== temp.id)) // no answer: the words go back into the box
      setText(message)
      setError(`${e.message || L.failed} — ${L.retryNote}`)
    } finally { if (alive.current) setSending(null) }
  }, [base, getContext, selection, lang, sending, L.failed, L.retryNote, onNewMessage])

  // words that were spoken to the orb (confirmed by the person there) arrive here as if typed
  const pendingRef = useRef(null)
  useEffect(() => {
    if (!pendingMessage || loading || sending || pendingRef.current === pendingMessage) return
    pendingRef.current = pendingMessage
    onPendingSent?.()
    send(pendingMessage)
  }, [pendingMessage, loading, sending, send, onPendingSent])

  const stopSpeaking = useCallback(() => { try { speechApi()?.cancel() } catch { /* nothing is speaking */ } setSpeakingId(null) }, [])
  const speak = useCallback((message) => {
    const api = speechApi()
    const voice = api ? findVoice(lang) : null
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
  }, [lang, L.noVoice, L.speakFail])
  useEffect(() => {
    const api = speechApi()
    if (!api) return undefined
    const warm = () => api.getVoices() // voices can arrive a moment after the page loads
    api.addEventListener?.('voiceschanged', warm)
    return () => { api.removeEventListener?.('voiceschanged', warm); try { api.cancel() } catch { /* nothing */ } }
  }, [])
  readAloudRef.current = readAloud
  speakRef.current = speak

  async function newChat() {
    if (!window.confirm(L.confirmNew)) return
    try { await fetch(`${base}/history`, { method: 'DELETE' }) } catch { /* the screen is cleared anyway */ }
    setMessages([]); setError('')
  }

  const updateMessage = useCallback((id, patch) => setMessages((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x))), [])
  const lastActionId = [...messages].reverse().find((x) => x.action && x.action.type !== 'none' && !x.resolved)?.id

  return (
    <section className="adu-chat" aria-label="Adu">
      {(messages.length > 0 || onAllDrafts) && (
        <div className="adu-chat-bar">
          {onAllDrafts && <button type="button" onClick={onAllDrafts} className="buddy-link">{L.allDrafts}</button>}
          {messages.length > 0 && <button type="button" onClick={newChat} className="buddy-link">{L.newChat}</button>}
        </div>
      )}
      <div className="buddy-list" ref={listRef} aria-live="polite">
        {loading && <p className="buddy-note">…</p>}
        {!loading && messages.length === 0 && (
          <div className="buddy-empty">
            <p>{L.hint}</p>
            <div className="buddy-starters">{(module === 'film' ? L.filmStarters : L.starters).map((s) => <button type="button" key={s} onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`buddy-msg is-${m.role}${m.local ? ' is-local' : ''}`}>
            <p>{m.content}</p>
            {m.role === 'assistant' && !m.local && m.content && (
              <button type="button" className="buddy-listen" onClick={() => (speakingId === m.id ? stopSpeaking() : speak(m))}>{speakingId === m.id ? `■ ${L.stopListen}` : `🔊 ${L.listen}`}</button>
            )}
            {m.role === 'assistant' && m.action && m.action.type !== 'none' && (
              <ActionNote action={m.action} L={L}>
                {renderAction?.({ message: m, action: m.action, current: m.id === lastActionId, update: (patch) => updateMessage(m.id, patch), lang })}
              </ActionNote>
            )}
          </div>
        ))}
        {sending && <div className="buddy-msg is-assistant is-thinking"><p>⏳ {L.thinking}… <b>{seconds}s</b></p></div>}
      </div>
      {voiceNote && <p className="buddy-note buddy-voice-note" role="status">{voiceNote}</p>}
      {error && <p className="buddy-error" role="alert">{error}</p>}
      <form className="buddy-input" onSubmit={(e) => { e.preventDefault(); send(text) }}>
        {InputComponent
          ? <InputComponent rows={2} value={text} placeholder={L.placeholder} disabled={Boolean(sending)} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); send(text) } }} />
          : <textarea value={text} rows={2} placeholder={L.placeholder} disabled={Boolean(sending)} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text) } }} />}
        <div className="buddy-input-row">
          <label className="buddy-auto">
            <input type="checkbox" checked={readAloud} onChange={(e) => { setReadAloud(e.target.checked); if (!e.target.checked) stopSpeaking(); try { localStorage.setItem('filmybase:aduReadAloud', e.target.checked ? '1' : '0') } catch { /* fine */ } }} />
            {L.readAloud}
          </label>
          <button type="submit" className="buddy-send" disabled={Boolean(sending) || !text.trim()}>{L.send}</button>
        </div>
      </form>
    </section>
  )
}
