import { useEffect, useState } from 'react'
import { ODIA_KEYS, odiaKeyHandler } from './odiaKeys.js'

const STORE = 'filmybase.odiaTyping'
const ROWS = [
  ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0'],
  ['KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU','KeyI','KeyO','KeyP','BracketLeft','BracketRight'],
  ['KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL','Semicolon','Quote'],
  ['KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM','Comma','Period','Slash'],
]
const LABEL = { BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' }
const labelOf = (code) => LABEL[code] ?? code.replace('Key', '').replace('Digit', '')

// Small switch next to the Full/Light button: English typing <-> Odia (Akruti layout) typing.
export default function OdiaKeyToggle() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(STORE) === '1' } catch { return false } })
  const [show, setShow] = useState(false)

  useEffect(() => {
    try { localStorage.setItem(STORE, on ? '1' : '0') } catch { /* private window: fine */ }
    if (!on) return undefined
    document.addEventListener('keydown', odiaKeyHandler, true)
    return () => document.removeEventListener('keydown', odiaKeyHandler, true)
  }, [on])

  return (
    <div className="odia-toggle">
      <button type="button" className={`odia-toggle-btn${on ? ' on' : ''}`} aria-pressed={on}
        title={on ? 'Typing in Odia (Akruti layout) — tap for English' : 'Typing in English — tap for Odia (Akruti layout)'}
        onClick={() => setOn(!on)}>
        {on ? 'ଓଡ଼ିଆ' : 'EN'}
      </button>
      {on && <button type="button" className="odia-toggle-keys" title="Show the Odia keyboard" onClick={() => setShow(!show)}>⌨</button>}
      {on && show && (
        <div className="odia-keyboard" role="img" aria-label="Odia keyboard layout">
          {ROWS.map((row, r) => (
            <div key={r} className="odia-krow" style={{ paddingLeft: r * 14 }}>
              {row.map((code) => (
                <span key={code} className="odia-key">
                  <i>{labelOf(code)}</i>
                  <b>{ODIA_KEYS[code][1]}</b>
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
