import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// AI Movie → the "Speak here" orb and the Buddy badge (the same two helpers the Movie screenplay has).
// The orb listens (the recording is only written down and translated: nothing changes until you say "Yes, send it"), then the confirmed words go to Adu's chat,
// which sorts them, shows what it would change, and only changes the screenplay when you press Apply (and Undo takes it back). The 💬 badge opens the same chat.
const MAX_SECONDS = 180
const TEXT = {
  en: {
    speak: 'Speak here', stop: 'Stop', thinking: 'Thinking…', label: (n) => `Speak to Adu about scene ${n}`, chat: 'Chat with Adu',
    listening: 'Listening… speak, then press the orb again.', nothing: 'I could not hear anything. Please try again, closer to the microphone.', fail: 'Something went wrong. Please try again.',
    working: 'Listening to your recording and writing down exactly what you said …', heard: 'I heard this — is it right?', yourWords: 'Your words', english: 'In English (translated exactly)',
    send: '✓ Yes, send it to Adu', fix: '✏ Fix the words', doneFix: 'Done editing', again: '🎙 Speak again', cancel: 'Cancel', retranslate: '🌐 Translate again', changed: 'words changed — translate again',
    noMic: 'This browser cannot use the microphone here. You can still type to Adu.',
  },
  hi: {
    speak: 'यहाँ बोलो', stop: 'रोको', thinking: 'सोच रहा हूँ…', label: (n) => `Adu से scene ${n} के बारे में बोलो`, chat: 'Adu से बात करो',
    listening: 'सुन रहा हूँ… बोलो, फिर orb दोबारा दबाओ।', nothing: 'कुछ सुनाई नहीं दिया। माइक के पास आकर फिर कोशिश करो।', fail: 'कुछ गड़बड़ हुई। फिर कोशिश करो।',
    working: 'आपकी रिकॉर्डिंग सुनकर ठीक वही लिख रहा हूँ जो आपने कहा …', heard: 'मैंने यह सुना — सही है?', yourWords: 'आपके शब्द', english: 'English में (ठीक अनुवाद)',
    send: '✓ हाँ, Adu को भेजो', fix: '✏ शब्द ठीक करो', doneFix: 'ठीक करना पूरा', again: '🎙 फिर बोलो', cancel: 'रद्द करो', retranslate: '🌐 फिर अनुवाद करो', changed: 'शब्द बदले — फिर अनुवाद करो',
    noMic: 'यह browser यहाँ माइक नहीं चला सकता। आप Adu को लिखकर बता सकते हो।',
  },
  or: {
    speak: 'ଏଠି କୁହ', stop: 'ବନ୍ଦ', thinking: 'ଭାବୁଛି…', label: (n) => `Adu କୁ ସିନ୍ ${n} ବିଷୟରେ କୁହ`, chat: 'Adu ସହ କଥା ହୁଅ',
    listening: 'ଶୁଣୁଛି… କୁହ, ତା’ପରେ orb ପୁଣି ଦବାଅ।', nothing: 'କିଛି ଶୁଣାଗଲା ନାହିଁ। ମାଇକ୍ ପାଖରେ ପୁଣି ଚେଷ୍ଟା କର।', fail: 'କିଛି ଭୁଲ ହେଲା। ପୁଣି ଚେଷ୍ଟା କର।',
    working: 'ତୁମ ରେକର୍ଡିଂ ଶୁଣି ଯାହା କହିଲ ଠିକ୍ ସେୟା ଲେଖୁଛି …', heard: 'ମୁଁ ଏହା ଶୁଣିଲି — ଠିକ୍ ଅଛି?', yourWords: 'ତୁମ କଥା', english: 'ଇଂରାଜୀରେ (ଠିକ୍ ଅନୁବାଦ)',
    send: '✓ ହଁ, Adu କୁ ପଠାଅ', fix: '✏ କଥା ସୁଧାର', doneFix: 'ସୁଧାର ଶେଷ', again: '🎙 ପୁଣି କୁହ', cancel: 'ବାତିଲ୍', retranslate: '🌐 ପୁଣି ଅନୁବାଦ', changed: 'କଥା ବଦଳିଛି — ପୁଣି ଅନୁବାଦ କର',
    noMic: 'ଏହି ବ୍ରାଉଜର୍ ଏଠି ମାଇକ୍ ଚଲାଇପାରିବ ନାହିଁ। ଆପଣ Adu କୁ ଲେଖି କହିପାରିବେ।',
  },
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
  reader.onerror = reject
  reader.readAsDataURL(blob)
})

export default function AiMovieVoiceOrb({ backendUrl, language = 'en', sceneNumber = 1, onSend, onOpenChat }) {
  const L = TEXT[language === 'or' ? 'or' : language === 'hi' ? 'hi' : 'en']
  const [phase, setPhase] = useState('idle') // idle | listening | understanding | confirm
  const [seconds, setSeconds] = useState(0)
  const [liveText, setLiveText] = useState('')
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState(null) // { transcript, english, editing, translating, edited }
  const session = useRef(null)
  const buttonRef = useRef(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; session.current?.cleanup?.() } }, [])

  async function start() {
    setMessage(''); setLiveText('')
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setMessage(L.noMic); return }
    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch { setMessage(L.noMic); return }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((type) => window.MediaRecorder.isTypeSupported?.(type)) || ''
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks = []
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data)
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    let recognition = null
    if (Recognition) { // live captions are only a preview; the AI listens to the real recording
      try {
        recognition = new Recognition()
        recognition.lang = language === 'hi' ? 'hi-IN' : language === 'or' ? 'or-IN' : 'en-IN'
        recognition.interimResults = true; recognition.continuous = true
        recognition.onresult = (event) => setLiveText(Array.from(event.results).map((r) => r[0].transcript).join(' '))
        recognition.onerror = () => {}
        recognition.start()
      } catch { recognition = null }
    }
    const startedAt = Date.now()
    const timer = setInterval(() => { const s = Math.round((Date.now() - startedAt) / 1000); setSeconds(s); if (s >= MAX_SECONDS) stop() }, 500)
    const cleanup = () => { clearInterval(timer); try { recognition?.stop() } catch { /* already stopped */ } stream.getTracks().forEach((track) => track.stop()) }
    session.current = { recorder, chunks, cleanup, mimeType: recorder.mimeType || mimeType || 'audio/webm', liveText: () => liveText }
    recorder.start(250)
    setSeconds(0); setPhase('listening')
  }

  function stop() {
    const s = session.current
    if (!s || s.recorder.state === 'inactive') return
    s.recorder.onstop = () => { s.cleanup(); session.current = null; understand(new Blob(s.chunks, { type: s.mimeType }), s.mimeType) }
    s.recorder.stop()
  }

  async function understand(blob, mimeType) {
    if (blob.size < 1500) { setPhase('idle'); setMessage(L.nothing); return }
    setPhase('understanding')
    try {
      const audio = await toBase64(blob)
      const response = await fetch(`${backendUrl}/api/voice/understand`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio, mimeType, liveText }) })
      const data = await response.json().catch(() => ({}))
      if (!alive.current) return
      if (!response.ok) { setMessage(data.error || L.fail); setPhase('idle') } else { setConfirm({ transcript: data.transcript, english: data.english, editing: false, translating: false, edited: false }); setPhase('confirm') }
    } catch { if (alive.current) { setMessage(L.fail); setPhase('idle') } }
    setLiveText('')
  }

  async function translateAgain() {
    if (!confirm?.transcript.trim()) return
    setConfirm({ ...confirm, translating: true })
    try {
      const response = await fetch(`${backendUrl}/api/voice/understand`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: confirm.transcript }) })
      const data = await response.json().catch(() => ({}))
      setConfirm((c) => (c ? { ...c, translating: false, ...(response.ok ? { english: data.english, edited: false } : {}) } : c))
    } catch { setConfirm((c) => (c ? { ...c, translating: false } : c)) }
  }

  const cancel = () => { setConfirm(null); setPhase('idle') }
  // what goes to Adu: the person's own words (Adu understands English, Hindi and Odia); the English translation only helps the person check them
  const sendIt = () => { const text = confirm?.transcript?.trim(); if (!text) return; setConfirm(null); setPhase('idle'); onSend?.(text) }

  const orbStyle = { right: 20, bottom: 96, left: 'auto', top: 'auto' }
  return createPortal(
    <>
      {(phase === 'understanding' || phase === 'confirm') && (
        <div className="voice-writer-panel" style={{ right: 12, bottom: 190 }} role="dialog" aria-label={L.speak}>
          {phase === 'understanding' && <p className="voice-panel-working">⏳ {L.working}</p>}
          {phase === 'confirm' && confirm && (
            <div className="voice-panel-confirm">
              <p className="voice-panel-title">{L.heard}</p>
              <p className="voice-panel-label">{L.yourWords}</p>
              {confirm.editing
                ? <textarea className="voice-panel-text" rows={4} value={confirm.transcript} onChange={(e) => setConfirm({ ...confirm, transcript: e.target.value, edited: true })} />
                : <blockquote className="voice-panel-quote">{confirm.transcript}</blockquote>}
              <p className="voice-panel-label">{L.english}</p>
              <blockquote className="voice-panel-quote is-english">{confirm.translating ? '…' : confirm.english || '—'}{confirm.edited && !confirm.translating ? ` (${L.changed})` : ''}</blockquote>
              <div className="voice-panel-actions">
                <button type="button" className="choose-button" onClick={sendIt} disabled={!confirm.transcript.trim() || confirm.translating}>{L.send}</button>
                <button type="button" className="cancel-button" onClick={() => setConfirm({ ...confirm, editing: !confirm.editing })}>{confirm.editing ? L.doneFix : L.fix}</button>
                {confirm.edited && <button type="button" className="cancel-button" onClick={translateAgain} disabled={confirm.translating}>{L.retranslate}</button>}
                <button type="button" className="cancel-button" onClick={() => { cancel(); start() }}>{L.again}</button>
                <button type="button" className="cancel-button" onClick={cancel}>{L.cancel}</button>
              </div>
            </div>
          )}
        </div>
      )}
      {(phase === 'listening' || message) && (
        <div className={`voice-writer-bubble${message && phase === 'idle' ? ' is-error' : ''}`} style={{ right: 12, bottom: 190 }} role="status">
          <p>{phase === 'listening' ? (liveText || L.listening) : message}</p>
          {phase === 'idle' && <button type="button" className="voice-writer-bubble-close" onClick={() => setMessage('')} aria-label="×">×</button>}
        </div>
      )}
      <button ref={buttonRef} type="button" className={`voice-writer-button is-${phase}`} style={orbStyle} aria-label={phase === 'listening' ? L.stop : L.label(sceneNumber)} title={`${L.speak} · ${L.label(sceneNumber)}`}
        aria-disabled={phase === 'understanding' || phase === 'confirm'}
        onClick={() => { if (phase === 'idle') start(); else if (phase === 'listening') stop() }}>
        <span className="voice-writer-orb" aria-hidden="true"><span className="voice-writer-mic">{phase === 'listening' ? '■' : '🎙'}</span></span>
        <span className="voice-writer-caption">
          {phase === 'idle' && L.speak}
          {phase === 'listening' && `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
          {(phase === 'understanding' || phase === 'confirm') && L.thinking}
        </span>
      </button>
      <button type="button" className="buddy-badge" style={{ right: 12, bottom: 160, left: 'auto', top: 'auto' }} onClick={() => onOpenChat?.()} aria-label={L.chat} title={L.chat}>💬</button>
    </>,
    document.body,
  )
}
