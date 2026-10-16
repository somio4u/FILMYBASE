// Odia typing layout (Akruti / InScript style). Each physical key gives [normal, with Shift].
// The keys are matched by their position on the keyboard (event.code), so it works on any English keyboard.
// To fix a key, change its pair here — nothing else needs to change.
// Read from the keyboard picture: every key cap shows the English label on the left and the Odia letters on
// the right (top = with Shift, bottom = normal). Each pair is [normal, with Shift].
// null = nothing on the cap there, so the key types normally. Keys marked "?" were hard to read in the picture.
export const ODIA_KEYS = {
  Backquote: ['।', 'ଵ'],                                  // shift ?
  Digit1: ['୧', '!'], Digit2: ['୨', '‘'], Digit3: ['୩', '’'], Digit4: ['୪', 'ଷ'], Digit5: ['୫', '%'], // 4 shift ?
  Digit6: ['୬', 'ଋ'], Digit7: ['୭', 'ଊ'], Digit8: ['୮', '*'], Digit9: ['୯', '('], Digit0: ['୦', ')'], // 6, 7 shift ?
  Minus: [null, null], Equal: [null, null],
  KeyQ: ['ବ', null],                                      // shift ? (small mark)
  KeyW: ['ପ', 'ଫ'], KeyE: ['ନ', '\u0B5C'], KeyR: ['ଦ', 'ଧ'], KeyT: ['ସ', 'ଓ'], KeyY: ['ା', 'ଔ'],
  KeyU: ['ଯ', 'ଟ'], KeyI: ['ଂ', '୦'], KeyO: ['ହ', 'ଉ'], KeyP: ['ୀ', 'ଢ'],                    // I, O shift ?
  BracketLeft: ['ଅ', 'ୃ'], BracketRight: ['ୗ', 'ୟ'], Backslash: ['ଆ', '|'],                   // ] both, \ normal ?
  KeyA: ['ମ', '\u0B5D'], KeyS: ['କ', 'ଖ'], KeyD: ['୍', null], KeyF: ['ତ', 'ଥ'], KeyG: ['ୁ', 'ଇ'],
  KeyH: ['ି', 'ଈ'], KeyJ: ['ର', 'ଣ'], KeyK: ['।', 'ଶ'], KeyL: ['ଟ', 'ଠ'],                    // G, H shift, K shift ?
  Semicolon: [null, null], Quote: ["'", 'ଁ'],
  KeyZ: ['ଭ', 'ଙ'], KeyX: ['ଗ', 'ଘ'], KeyC: ['ଜ', 'ଝ'], KeyV: ['ଚ', 'ଛ'], KeyB: ['ଽ', 'ଡ'],    // Z, B normal ?
  KeyN: ['ୂ', 'ଞ'], KeyM: ['ଲ', 'ଳ'], Comma: [',', 'ଏ'], Period: ['.', 'ଐ'], Slash: [null, null], // N both, M shift ?
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
