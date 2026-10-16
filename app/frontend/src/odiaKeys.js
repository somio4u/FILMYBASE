// Odia typing layout (Akruti / InScript style). Each physical key gives [normal, with Shift].
// The keys are matched by their position on the keyboard (event.code), so it works on any English keyboard.
// To fix a key, change its pair here — nothing else needs to change.
// null = that Shift position is blank on the layout, so the key types normally.
export const ODIA_KEYS = {
  Backquote: ['|', '୨'],
  Digit1: ['୧', '!'], Digit2: ['୨', '‘'], Digit3: ['୩', '’'], Digit4: ['୪', 'ୟ'], Digit5: ['୫', '%'],
  Digit6: ['୬', 'ତ୍ତ'], Digit7: ['୭', 'ଞ'], Digit8: ['୮', '*'], Digit9: ['୯', '('], Digit0: ['୦', ')'],
  Minus: ['=', '-'], Equal: ['=', '+'],
  KeyQ: ['ବ', 'ଽ'], KeyW: ['ପ', 'ଫ'], KeyE: ['ନ', 'ତ୍ର'], KeyR: ['ଦ', 'ଧ'], KeyT: ['ସ', 'ଞ୍ଚ'],
  KeyY: ['ା', 'ଞ୍ଜ'], KeyU: ['ଯ', 'ଶ'], KeyI: ['ଂ', 'O'], KeyO: ['ହ', 'ଭ'], KeyP: ['ି', 'ଢ'],
  BracketLeft: ['ଅ', 'ୃ'], BracketRight: ['୍', '୪'], Backslash: ['ୟ', '|'],
  KeyA: ['ମ', 'ଛ'], KeyS: ['କ', 'ଖ'], KeyD: ['୍', null], KeyF: ['ତ', 'ଥ'], KeyG: ['େ', 'ଳ'],
  KeyH: ['ା', 'ଲ'], KeyJ: ['ର', 'ଣ'], KeyK: ['।', 'ଙ'], KeyL: ['୨', 'ଷ'],
  Semicolon: [';', ':'], Quote: ['’', '”'],
  KeyZ: ['ଉ', 'ଙ୍ଗ'], KeyX: ['ଗ', 'ଘ'], KeyC: ['ଜ', 'ଝ'], KeyV: ['ଚ', 'ଛ'], KeyB: ['ଠ', 'ଡ'],
  KeyN: ['ୁ', 'ଣ'], KeyM: ['ୂ', 'ଲ'], Comma: [',', 'ଏ'], Period: ['.', 'ଐ'], Slash: ['/', '?'],
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
