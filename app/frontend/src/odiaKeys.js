// Odia typing layout (Akruti / InScript style). Each physical key gives [normal, with Shift].
// The keys are matched by their position on the keyboard (event.code), so it works on any English keyboard.
// To fix a key, change its pair here — nothing else needs to change.
export const ODIA_KEYS = {
  Digit1: ['୧', 'ଁ'], Digit2: ['୨', '@'], Digit3: ['୩', '#'], Digit4: ['୪', '$'], Digit5: ['୫', '%'],
  Digit6: ['୬', '^'], Digit7: ['୭', '&'], Digit8: ['୮', '*'], Digit9: ['୯', '('], Digit0: ['୦', ')'],
  KeyQ: ['ୌ', 'ଔ'], KeyW: ['ୈ', 'ଐ'], KeyE: ['ା', 'ଆ'], KeyR: ['ୀ', 'ଈ'], KeyT: ['ୂ', 'ଊ'],
  KeyY: ['ବ', 'ଭ'], KeyU: ['ହ', 'ଙ'], KeyI: ['ଗ', 'ଘ'], KeyO: ['ଦ', 'ଧ'], KeyP: ['ଜ', 'ଝ'],
  BracketLeft: ['ଡ', 'ଢ'], BracketRight: ['଼', 'ଞ'],
  KeyA: ['ୋ', 'ଓ'], KeyS: ['େ', 'ଏ'], KeyD: ['୍', 'ଅ'], KeyF: ['ି', 'ଇ'], KeyG: ['ୁ', 'ଉ'],
  KeyH: ['ପ', 'ଫ'], KeyJ: ['ର', 'ୱ'], KeyK: ['କ', 'ଖ'], KeyL: ['ତ', 'ଥ'],
  Semicolon: ['ଚ', 'ଛ'], Quote: ['ଟ', 'ଠ'],
  KeyZ: ['ୃ', 'ଋ'], KeyX: ['ଂ', 'ଃ'], KeyC: ['ମ', 'ଣ'], KeyV: ['ନ', 'ଳ'], KeyB: ['ଵ', 'ୟ'],
  KeyN: ['ଲ', 'ଳ'], KeyM: ['ସ', 'ଶ'], Comma: [',', 'ଷ'], Period: ['।', 'ଽ'], Slash: ['ୟ', '?'],
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
  event.preventDefault()
  document.execCommand('insertText', false, event.shiftKey ? pair[1] : pair[0])
}
