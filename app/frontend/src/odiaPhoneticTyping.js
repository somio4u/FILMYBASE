// Phonetic Odia typing on the screen. You type the word in English letters; it stays English while you type, and a strip of choices shows the Odia it can
// mean (the most likely first). Space (or a full stop, comma, ? … or Enter) turns the word into the FIRST choice; a number key 1–5, or a tap on a choice,
// takes another one — and the app remembers that pick (My words), so the same word comes out right next time. Backspace straight after a word turned into
// Odia gives the English letters back (and the strip of choices again). Nothing changes while the word is half typed, and a word left without a space stays
// as typed. Which Odia word a typed word means is decided in odiaFuzzy.js from the words the writer's own scripts contain (loadCorpus) and his own words.
// It works in every text box and in the screenplay editor. Ctrl+Space (OdiaKeyToggle) types an English word (a CHARACTER name, a scene heading) in between.
import { isTypingTarget } from './odiaKeys.js'
import { candidatesFor, buildIndex } from './odiaFuzzy.js'
import { parseWordLines } from './odiaWords.js'

// the writer's own words ("mun = ମୁଁ"), kept on this device; they win over everything else
export const MY_WORDS_KEY = 'filmybase.odiaWords'
export function myWords() {
  try { return parseWordLines(Object.entries(JSON.parse(localStorage.getItem(MY_WORDS_KEY) || '{}')).map(([r, o]) => `${r} = ${o}`).join('\n')) } catch { return {} }
}
export function saveMyWords(words) {
  try { localStorage.setItem(MY_WORDS_KEY, JSON.stringify(words)); return true } catch { return false }
}

// the words of the writer's scripts, counted by the server (GET /api/odia-words), turned into the index the matching uses; kept on this device for a day
const CORPUS_KEY = 'filmybase.odiaCorpus'
let index = new Map()
export function setCorpus(entries) { index = buildIndex(Array.isArray(entries) ? entries : []) }
export async function loadCorpus(backendUrl) {
  try {
    const saved = JSON.parse(localStorage.getItem(CORPUS_KEY) || 'null')
    if (saved && Date.now() - saved.at < 24 * 3600 * 1000 && Array.isArray(saved.words)) { setCorpus(saved.words); return saved.words.length }
  } catch { /* no saved copy */ }
  try {
    const response = await fetch(`${backendUrl}/api/odia-words`)
    if (!response.ok) return 0
    const { words } = await response.json()
    setCorpus(words)
    try { localStorage.setItem(CORPUS_KEY, JSON.stringify({ at: Date.now(), words })) } catch { /* too big or private window: fetched again next time */ }
    return Array.isArray(words) ? words.length : 0
  } catch { return 0 }
}

let busy = false // our own edit fires the same events; it must not be treated as typing
const lastConversion = new WeakMap() // text box -> { roman, shown }: the word just turned into Odia (Backspace right after it gives the English letters back)

// the strip of choices: who is listening (the screen part), and what the choices are right now
let listener = null
let active = null // { el, word, candidates } while an English word is waiting to be turned into Odia
export function onChoices(fn) { listener = fn; return () => { if (listener === fn) listener = null } }
const show = (next) => { active = next; listener?.(next ? { word: next.word, candidates: next.candidates } : null) }

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

const choicesFor = (word) => candidatesFor(word, { words: myWords(), index })

// replaces the English word before the caret with `chosen` (default: the first choice), and adds `after` (the space or the mark that was typed) behind it
function convertWord(el, word, after = '', chosen = null) {
  busy = true
  try {
    const shown = chosen ?? choicesFor(word)[0] ?? word
    selectBeforeCaret(el, word.length)
    document.execCommand('insertText', false, `${shown}${after}`)
    lastConversion.set(el, { roman: word, shown: `${shown}${after}` })
  } finally {
    busy = false
  }
  show(null)
}

// the writer picked a choice that is not the first: remember it, so this word comes out his way from now on
function learn(word, chosen) {
  const plain = word === word.toLowerCase() || /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : null
  if (!plain || !chosen) return
  const words = myWords()
  words[plain] = chosen
  saveMyWords(words)
}

// the writer took choice number `n` (1-based): by a number key or by a tap on the strip
export function chooseChoice(n) {
  if (!active) return false
  const { el, word, candidates } = active
  const chosen = candidates[n - 1]
  if (!chosen || pendingWord(el) !== word) return false
  el.focus()
  convertWord(el, word, '', chosen)
  if (n > 1) learn(word, chosen)
  return true
}

// after every letter typed or taken away: what is the English word waiting before the caret, and what can it mean?
export function phoneticInput(event) {
  if (busy || event.isComposing) return
  const el = event.target
  if (!isTypingTarget(el)) return
  const word = pendingWord(el)
  show(word ? { el, word, candidates: choicesFor(word) } : null)
}
export const phoneticBlur = () => show(null)

// Space and the marks that end a word; Backspace straight after a conversion
export function phoneticBeforeInput(event) {
  if (busy || event.isComposing) return
  const el = event.target
  if (!isTypingTarget(el)) return
  // Backspace straight after a word turned into Odia: the English letters come back (and the choices again), so a word that came out wrong can be
  // typed again or taken from the strip
  const done = lastConversion.get(el)
  if (done) {
    if (event.inputType === 'deleteContentBackward' && textBeforeCaret(el, done.shown.length) === done.shown) {
      event.preventDefault()
      busy = true
      try { selectBeforeCaret(el, done.shown.length); document.execCommand('insertText', false, done.roman) } finally { busy = false }
      lastConversion.delete(el)
      show({ el, word: done.roman, candidates: choicesFor(done.roman) })
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

// Enter: the editor handles it itself (a new line), so the word before the caret is converted first and the key then carries on.
// A number 1–5 while the strip is showing takes that choice; Escape closes the strip and keeps the English word.
export function phoneticKeyDown(event) {
  if (busy || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
  const el = event.target
  if (!isTypingTarget(el)) return
  if (active && active.el === el) {
    if (/^[1-5]$/.test(event.key) && Number(event.key) <= active.candidates.length) {
      if (chooseChoice(Number(event.key))) event.preventDefault()
      return
    }
    if (event.key === 'Escape') { show(null); return }
  }
  if (event.key !== 'Enter') return
  const word = pendingWord(el)
  if (word) convertWord(el, word)
}
