// Odia typing layout (Akruti / InScript style). Each physical key gives [normal, with Shift].
// The keys are matched by their position on the keyboard (event.code), so it works on any English keyboard.
// To fix a key, change its pair here — nothing else needs to change.
// Taken from the owner's typed test: the same keys typed once normally and once with Shift on his Odia keyboard.
// Each pair is [normal, with Shift]. null = that key just types normally (English). '' = the key types nothing.
// Z-row to Q-row follow his sequence exactly. K and L (aa-kar and e-kar) follow the keyboard picture.
export const ODIA_KEYS = {
  Backquote: ['।', 'ଃ'],
  Digit1: ['୧', null], Digit2: ['୨', null], Digit3: ['୩', null], Digit4: ['୪', 'କ୍ଷ'], Digit5: ['୫', null],
  Digit6: ['୬', 'ଋ'], Digit7: ['୭', null], Digit8: ['୮', null], Digit9: ['୯', null], Digit0: ['୦', null],
  Minus: [null, null], Equal: [null, null],
  KeyQ: ['ବ', null], KeyW: ['ପ', 'ଫ'], KeyE: ['ନ', '\u0B21\u0B3C'], KeyR: ['ଦ', 'ଧ'], KeyT: ['ସ', 'ଓ'],
  KeyY: ['ୌ', 'ଔ'], KeyU: ['ଯ', 'ଟ'], KeyI: ['ଂ', 'ଠ'], KeyO: ['ହ', 'ଡ'], KeyP: ['ୈ', 'ଢ'],
  BracketLeft: ['ଅ', 'ୃ'], BracketRight: ['୍ର', '୍ୟ'], Backslash: ['ୟ', 'ଞ'],
  KeyA: ['ମ', '\u0B22\u0B3C'], KeyS: ['କ', 'ଖ'], KeyD: ['୍', ''], KeyF: ['ତ', 'ଥ'], KeyG: ['ି', 'ଇ'],
  KeyH: ['ୀ', 'ଈ'], KeyJ: ['ର', 'ଣ'], KeyK: ['ା', 'ଶ'], KeyL: ['େ', 'ଷ'],
  Semicolon: [null, null], Quote: [null, 'ଁ'],
  KeyZ: ['ଭ', 'ଙ'], KeyX: ['ଗ', 'ଘ'], KeyC: ['ଜ', 'ଝ'], KeyV: ['ଚ', 'ଛ'], KeyB: ['ୁ', 'ଉ'],
  KeyN: ['ୂ', 'ଊ'], KeyM: ['ଳ', 'ଲ'], Comma: [null, 'ଏ'], Period: [null, 'ଐ'], Slash: [null, null],
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
  if (letter === null) return
  event.preventDefault()
  if (letter) document.execCommand('insertText', false, letter) // '' = the key types nothing
}
