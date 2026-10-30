// Phonetic Odia typing on the screen (the rules are in odiaPhonetic.js): while it is on, the letters you type are collected into a word and the word is
// shown in Odia, redrawn after every key — pa → ପ, pab → ପବ, pabana → ପବନ. A space, a number, a full stop, Enter or moving the caret ends the word.
// Backspace takes the last English letter off the word (and goes on until the Odia on screen really changes). It works in every text box and in the screenplay editor (the same boxes as the key-layout typing).
import { isTypingTarget } from './odiaKeys.js'
import { isPhoneticKey, transliterate } from './odiaPhonetic.js'

const words = new WeakMap() // text box -> { roman, shown }: the English letters of the word being typed, and the Odia now on screen for them
let busy = false // our own edits fire the same events; they must not be treated as typing

// the `count` characters just before the caret (null when something is selected or there is no caret)
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

// puts `next` where the word `previous` is (just before the caret)
function replaceWord(el, previous, next) {
  busy = true
  try {
    if (previous) selectBeforeCaret(el, previous.length)
    if (next) document.execCommand('insertText', false, next)
    else if (previous) document.execCommand('delete')
  } finally {
    busy = false
  }
}

// is the word we remember still exactly where we left it, right before the caret? (not, after a click or an arrow key: then a new word starts)
function currentWord(el) {
  const word = words.get(el)
  if (!word) return null
  return textBeforeCaret(el, word.shown.length) === word.shown ? word : null
}

export function phoneticBeforeInput(event) {
  if (busy || event.isComposing) return
  const el = event.target
  if (!isTypingTarget(el)) return
  const { inputType, data } = event

  if (inputType === 'insertText' && data && data.length === 1 && isPhoneticKey(data)) {
    const word = currentWord(el)
    const roman = `${word ? word.roman : ''}${data}`
    const shown = transliterate(roman)
    event.preventDefault()
    replaceWord(el, word ? word.shown : '', shown)
    words.set(el, { roman, shown })
    return
  }
  if (inputType === 'deleteContentBackward') {
    const word = currentWord(el)
    if (word && word.roman) {
      // a closing "a" shows nothing (it is built into the letter), so Backspace goes on until something visible has changed
      let roman = word.roman.slice(0, -1)
      let shown = transliterate(roman)
      while (roman && shown === word.shown) { roman = roman.slice(0, -1); shown = transliterate(roman) }
      event.preventDefault()
      replaceWord(el, word.shown, shown)
      if (roman) words.set(el, { roman, shown })
      else words.delete(el)
      return
    }
  }
  words.delete(el) // a space, a number, Enter, paste, anything else: the word is finished
}
