import { useEffect, useState } from 'react'
import { ODIA_KEYS, odiaKeyHandler } from './odiaKeys.js'
import { PHONETIC_HELP } from './odiaPhonetic.js'
import { phoneticBeforeInput } from './odiaPhoneticTyping.js'

const STORE = 'filmybase.odiaTyping'
const ROWS = [
  ['Backquote','Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0','Minus','Equal'],
  ['KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU','KeyI','KeyO','KeyP','BracketLeft','BracketRight','Backslash'],
  ['KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL','Semicolon','Quote'],
  ['KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM','Comma','Period','Slash'],
]
const LABEL = { Backquote: '`', Backslash: '\\', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' }
const labelOf = (code) => LABEL[code] ?? code.replace('Key', '').replace('Digit', '')

// Small switch next to the Full/Light button: English typing → Odia key layout (Akruti) → Odia with English letters (type pabana, get ପବନ) → English again.
// Ctrl+Space jumps between English and the last Odia typing used (to write a CHARACTER name or a scene heading in English and come back).
const MODES = ['en', 'key', 'phon']
const LABEL_OF = { en: 'EN', key: 'ଓଡ଼ିଆ', phon: 'ଓଡ଼ିଆ·abc' }
const TITLE_OF = {
  en: 'Typing in English — tap for Odia (key layout)',
  key: 'Typing in Odia (Akruti key layout) — tap for Odia with English letters',
  phon: 'Typing Odia with English letters (pabana → ପବନ) — tap for English',
}
const readMode = () => { try { const v = localStorage.getItem(STORE); return v === 'p' ? 'phon' : v === '1' ? 'key' : 'en' } catch { return 'en' } }

export default function OdiaKeyToggle() {
  const [mode, setMode] = useState(readMode)
  const [show, setShow] = useState(false)
  const [lastOdia, setLastOdia] = useState(() => (readMode() === 'phon' ? 'phon' : 'key'))
  const [tryText, setTryText] = useState('')

  useEffect(() => {
    const turnOn = () => setMode((m) => (m === 'en' ? 'key' : m))
    window.addEventListener('filmybase:odia-on', turnOn)
    return () => window.removeEventListener('filmybase:odia-on', turnOn)
  }, [])

  useEffect(() => {
    try { localStorage.setItem(STORE, mode === 'phon' ? 'p' : mode === 'key' ? '1' : '0') } catch { /* private window: fine */ }
    if (mode !== 'en') setLastOdia(mode)
    if (mode === 'key') {
      document.addEventListener('keydown', odiaKeyHandler, true)
      return () => document.removeEventListener('keydown', odiaKeyHandler, true)
    }
    if (mode === 'phon') {
      document.addEventListener('beforeinput', phoneticBeforeInput, true)
      return () => document.removeEventListener('beforeinput', phoneticBeforeInput, true)
    }
    return undefined
  }, [mode])

  useEffect(() => {
    const quick = (event) => {
      if (!event.ctrlKey || event.code !== 'Space' || event.altKey || event.metaKey) return
      event.preventDefault()
      setMode((m) => (m === 'en' ? lastOdia : 'en'))
    }
    document.addEventListener('keydown', quick, true)
    return () => document.removeEventListener('keydown', quick, true)
  }, [lastOdia])

  const on = mode !== 'en'
  return (
    <div className="odia-toggle">
      <button type="button" className={`odia-toggle-btn${on ? ' on' : ''}`} aria-pressed={on}
        title={`${TITLE_OF[mode]}. Ctrl+Space switches between English and Odia.`}
        onClick={() => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])}>
        {LABEL_OF[mode]}
      </button>
      {on && <button type="button" className="odia-toggle-keys" title={mode === 'phon' ? 'Show how to type' : 'Show the Odia keyboard'} onClick={() => setShow(!show)}>⌨</button>}
      {mode === 'phon' && show && (
        <div className="odia-keyboard odia-phonetic-help" role="note" aria-label="Typing Odia with English letters">
          <p><b>Type the sound in English letters</b> — the word turns into Odia as you type.</p>
          <input type="text" className="odia-try" value={tryText} placeholder="try here: pabana" onChange={(e) => setTryText(e.target.value)} aria-label="Try typing here" />
          <table>
            <tbody>
              {PHONETIC_HELP.map(([typed, gets, example]) => (
                <tr key={typed}><td><code>{typed}</code></td><td>{gets}</td><td>{example}</td></tr>
              ))}
            </tbody>
          </table>
          <p>Space ends a word. <b>Ctrl+Space</b> switches to English (for CHARACTER names and scene headings) and back. Capital letters are for the thick sounds (T D N L).</p>
        </div>
      )}
      {mode === 'key' && show && (
        <div className="odia-keyboard" role="img" aria-label="Odia keyboard layout">
          {ROWS.map((row, r) => (
            <div key={r} className="odia-krow" style={{ paddingLeft: r * 14 }}>
              {row.map((code) => (
                <span key={code} className="odia-key">
                  <i>{labelOf(code)}</i>
                  <b>{ODIA_KEYS[code][1] ?? ''}</b>
                  <em>{ODIA_KEYS[code][0]}</em>
                </span>
              ))}
            </div>
          ))}
          <p>Big = Shift. Small = normal key.</p>
        </div>
      )}
    </div>
  )
}
