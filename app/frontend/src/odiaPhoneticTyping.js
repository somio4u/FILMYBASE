// Phonetic Odia typing on the screen (the rules are in odiaPhonetic.js). You type the word in English letters and it stays English while you type
// (pabana); when you press Space the word turns into Odia (ପବନ) and the space is added. The same happens before a full stop, comma, question mark and
// the like, and when you press Enter. Nothing changes while the word is half typed, and a word you leave without a space stays as typed.
// It works in every text box and in the screenplay editor (the same boxes as the key-layout typing). Ctrl+Space (OdiaKeyToggle) is the way to type an
// English word (a CHARACTER name, a scene heading) in between.
import { isTypingTarget } from './odiaKeys.js'
import { transliterate } from './odiaPhonetic.js'
import { parseWordLines } from './odiaWords.js'

// the writer's own words ("mun = ମୁଁ"), kept on this device; they win over the built-in list
export const MY_WORDS_KEY = 'filmybase.odiaWords'
export function myWords() {
  try { return parseWordLines(Object.entries(JSON.parse(localStorage.getItem(MY_WORDS_KEY) || '{}')).map(([r, o]) => `${r} = ${o}`).join('\n')) } catch { return {} }
}
export function saveMyWords(words) {
  try { localStorage.setItem(MY_WORDS_KEY, JSON.stringify(words)); return true } catch { return false }
}

let busy = false // our own edit fires the same events; it must not be treated as typing
const lastConversion = new WeakMap() // text box -> { roman, shown }: the word just turned into Odia (Backspace right after it gives the English letters back)

const ROMAN_WORD_AT_END = /[A-Za-z|~]+$/
const ENDS_A_WORD = /^[\s.,;:!?()"'“”‘’\-–—…]$/ // typed characters that finish a word (a space is the main one)

// the text just before the caret (null when something is selected or there is no caret)
function textBeforeCaret(el, count) {
  if (el.isContentEditable) {
    const sel = window.getSelection()
    const node = sel?.anchorNode
    if (!sel?.isCollapsed || node?.nodeType !== 3) return null
    return node.data.slice(Math.max(0, sel.anchorOffset - count), sel.anchorOffset)
  }
  const { selectionStart: start, selectionEnd: end, value } = el
  if (start === null || start !== end) return null
  return value.slice(Math.max(0, start - count), start)
}

function selectBeforeCaret(el, count) {
  if (el.isContentEditable) {
    const sel = window.getSelection()
    const node = sel.anchorNode
    sel.setBaseAndExtent(node, sel.anchorOffset - count, node, sel.anchorOffset)
    return
  }
  el.setSelectionRange(el.selectionStart - count, el.selectionStart)
}

// the English word right before the caret, or '' when there is none
function pendingWord(el) {
  const before = textBeforeCaret(el, 80)
  return before ? (ROMAN_WORD_AT_END.exec(before)?.[0] ?? '') : ''
}

// replaces the English word before the caret with its Odia, and adds `after` (the space or the mark that was typed) right behind it
function convertWord(el, word, after = '') {
  busy = true
  try {
    const shown = transliterate(word, { words: myWords() })
    selectBeforeCaret(el, word.length)
    document.execCommand('insertText', false, `${shown}${after}`)
    lastConversion.set(el, { roman: word, shown: `${shown}${after}` })
  } finally {
    busy = false
  }
}

// Space and the marks that end a word
export function phoneticBeforeInput(event) {
  if (busy || event.isComposing) return
  const el = event.target
  if (!isTypingTarget(el)) return
  // Backspace straight after a word turned into Odia: the English letters come back (so a word that came out wrong can be typed again, e.g. with a
  // capital for the thick sounds: kana → କନ, Backspace → kana, then kaNa → କଣ)
  const done = lastConversion.get(el)
  if (done) {
    if (event.inputType === 'deleteContentBackward' && textBeforeCaret(el, done.shown.length) === done.shown) {
      event.preventDefault()
      busy = true
      try { selectBeforeCaret(el, done.shown.length); document.execCommand('insertText', false, done.roman) } finally { busy = false }
      lastConversion.delete(el)
      return
    }
    lastConversion.delete(el) // anything else typed: the chance to take the conversion back is over
  }
  if (event.inputType !== 'insertText' || !event.data || event.data.length !== 1 || !ENDS_A_WORD.test(event.data)) return
  const word = pendingWord(el)
  if (!word) return
  event.preventDefault()
  convertWord(el, word, event.data)
}

// Enter: the editor handles it itself (a new line), so the word before the caret is converted first and the key then carries on
export function phoneticKeyDown(event) {
  if (busy || event.isComposing || event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey) return
  const el = event.target
  if (!isTypingTarget(el)) return
  const word = pendingWord(el)
  if (word) convertWord(el, word)
}
