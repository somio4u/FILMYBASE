// Odia typing layout (Akruti / InScript style). Each physical key gives [normal, with Shift].
// The keys are matched by their position on the keyboard (event.code), so it works on any English keyboard.
// To fix a key, change its pair here — nothing else needs to change.
// null = that Shift position is blank on the layout, so the key types normally.
export const ODIA_KEYS = {
  Digit1: ['୧', null], Digit2: ['୨', null], Digit3: ['୩', null], Digit4: ['୪', '₹'], Digit5: ['୫', null],
  Digit6: ['୬', null], Digit7: ['୭', null], Digit8: ['୮', null], Digit9: ['୯', '('], Digit0: ['୦', ')'],
  Minus: ['-', 'ଃ'], Equal: ['ୃ', 'ୠ'],
  KeyQ: ['ୌ', 'ଔ'], KeyW: ['ୈ', 'ଐ'], KeyE: ['ା', 'ଆ'], KeyR: ['ୀ', 'ଈ'], KeyT: ['ୂ', 'ଊ'],
  KeyY: ['ବ', 'ଭ'], KeyU: ['ହ', 'ଙ'], KeyI: ['ଗ', 'ଘ'], KeyO: ['ଦ', 'ଧ'], KeyP: ['ଜ', 'ଝ'],
  BracketLeft: ['ଡ', 'ଢ'], BracketRight: ['଼', 'ଞ'],
  KeyA: ['ୋ', 'ଓ'], KeyS: ['େ', 'ଏ'], KeyD: ['୍', 'ଅ'], KeyF: ['ି', 'ଇ'], KeyG: ['ୁ', 'ଉ'],
  KeyH: ['ପ', 'ଫ'], KeyJ: ['ର', 'ଋ'], KeyK: ['କ', 'ଖ'], KeyL: ['ତ', 'ଥ'],
  Semicolon: ['ଚ', 'ଛ'], Quote: ['ଟ', 'ଠ'],
  KeyZ: ['୍ର', 'ର୍'], KeyX: ['ଂ', 'ଁ'], KeyC: ['ମ', 'ଣ'], KeyV: ['ନ', null], KeyB: ['ଵ', 'ଳ'],
  KeyN: ['ଲ', '\u0B5C'], KeyM: ['ସ', 'ଶ'], Comma: [',', 'ଷ'], Period: ['.', '।'], Slash: ['ଯ', 'ୟ'],
}

const TYPING_TAGS = ['INPUT', 'TEXTAREA']
const BAD_INPUT_TYPES = ['password', 'number', 'email', 'url', 'date', 'time', 'file', 'checkbox', 'radio']

function isTypingTarget(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  if (!TYPING_TAGS.includes(el.tagName)) return false
  return !BAD_INPUT_TYPES.includes((el.type || '').toLowerCase())
}

// Key handler: while Odia mode is on, turns a plain key press into the Odia letter.
export function odiaKeyHandler(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
  const pair = ODIA_KEYS[event.code]
  if (!pair || !isTypingTarget(event.target)) return
  const letter = event.shiftKey ? pair[1] : pair[0]
  if (!letter) return
  event.preventDefault()
  document.execCommand('insertText', false, letter)
}
