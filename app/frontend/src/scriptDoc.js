// The screenplay page as a plain list of LINES (like a word processor), and the way back to the saved elements.
//
// Saved element:   { type: 'action' | 'dialogue' | 'transition' | 'flashback', character, characterModifier, parenthetical, text }
// Page lines:      { t: 'action' | 'character' | 'parenthetical' | 'dialogue' | 'transition' | 'flashback', text, ch?, el? }
//
// A saved dialogue becomes up to three lines (the CHARACTER, an optional (parenthetical), the dialogue) and the lines are put back
// together on every change. A dialogue line with no character above it is not a dialogue, so it is saved as an action line.

export const LINE_TYPES = ['action', 'character', 'parenthetical', 'dialogue', 'transition', 'flashback']
export const MODIFIERS = ['V.O.', 'O.S.', 'O.C.', "CONT'D"]

// "RAHUL (V.O.)" -> { name: "RAHUL", modifier: "V.O." }
export function splitModifier(text) {
  const match = String(text ?? '').match(/^(.*?)\s*\(\s*(V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT['’]?D\.?)\s*\)\s*$/i)
  if (!match) return { name: String(text ?? '').trim(), modifier: '' }
  const raw = match[2].toUpperCase().replace(/\./g, '').replace('’', "'")
  const modifier = { VO: 'V.O.', OS: 'O.S.', OC: 'O.C.', "CONT'D": "CONT'D", CONTD: "CONT'D" }[raw] ?? ''
  return { name: match[1].trim(), modifier }
}

export function linesFromElements(elements, glow = null) {
  const lines = []
  ;(elements ?? []).forEach((e, el) => {
    const text = String(e?.text ?? '')
    if (e?.type === 'dialogue') {
      const mod = e.characterModifier && e.characterModifier !== 'none' ? ` (${e.characterModifier})` : ''
      lines.push({ t: 'character', text: `${e.character ?? ''}${mod}`, el })
      if (e.parenthetical) lines.push({ t: 'parenthetical', text: String(e.parenthetical).replace(/^\(|\)$/g, ''), el })
      text.split('\n').forEach((part) => lines.push({ t: 'dialogue', text: part, el }))
    } else if (e?.type === 'transition') lines.push({ t: 'transition', text, el })
    else if (e?.type === 'flashback') lines.push({ t: 'flashback', text, ch: e.character ?? '', el })
    else lines.push({ t: 'action', text, el })
  })
  return lines.map((l) => ({ ...l, glow: Boolean(glow && l.el >= glow.from && l.el < glow.from + glow.count) }))
}

const blank = () => ({ type: 'action', character: '', characterModifier: 'none', parenthetical: '', text: '' })

// lines -> saved elements, plus for every line the index of the element it belongs to (for the voice orb and the cursor)
export function elementsFromLines(lines) {
  const elements = []
  const lineToElement = []
  let cur = null
  for (const line of lines) {
    const text = String(line.text ?? '').replace(/​/g, '')
    if (line.t === 'character') {
      const { name, modifier } = splitModifier(text)
      cur = { ...blank(), type: 'dialogue', character: name.toUpperCase(), characterModifier: modifier || 'none' }
      elements.push(cur)
    } else if (line.t === 'parenthetical' && cur && cur.text === '' && cur.parenthetical === '') {
      cur.parenthetical = text.replace(/^\s*\(|\)\s*$/g, '').trim()
    } else if (line.t === 'dialogue' && cur) {
      cur.text = cur.text === '' && !cur.started ? text : `${cur.text}\n${text}`
      cur.started = true
    } else {
      cur = null
      if (line.t === 'transition') elements.push({ ...blank(), type: 'transition', text: text.toUpperCase() })
      else if (line.t === 'flashback') elements.push({ ...blank(), type: 'flashback', character: line.ch ?? '', text })
      else elements.push({ ...blank(), text: line.t === 'parenthetical' ? `(${text.replace(/^\s*\(|\)\s*$/g, '')})` : text })
    }
    lineToElement.push(elements.length - 1)
  }
  elements.forEach((e) => { delete e.started })
  return { elements, lineToElement }
}

// what to save: no empty lines, no speech without words
export const cleanForSave = (elements) => (elements ?? []).filter((e) => String(e.text ?? '').trim() !== '')

// the type a new line gets when Enter is pressed at the end of a line of type `t`
export function nextType(t, hasTextAfterCaret = false) {
  if (t === 'character' || t === 'parenthetical') return 'dialogue'
  if (t === 'dialogue') return hasTextAfterCaret ? 'dialogue' : 'action'
  return t === 'transition' || t === 'flashback' ? 'action' : (hasTextAfterCaret ? t : 'action')
}

// Tab / Shift+Tab: the next type in the writer's cycle
export function cycleType(t, back = false) {
  const order = ['action', 'character', 'parenthetical', 'dialogue', 'transition']
  const i = order.indexOf(t)
  if (i < 0) return 'action'
  return order[(i + (back ? order.length - 1 : 1)) % order.length]
}

// Names to offer while a CHARACTER line is typed: every name that starts with what was typed, or has a word that does
export function matchNames(typed, names, limit = 8) {
  const q = String(typed ?? '').trim().toUpperCase()
  if (!q) return []
  const seen = new Set()
  const hits = []
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim().toUpperCase()
    if (!name || seen.has(name) || name === q) continue
    seen.add(name)
    const words = name.split(/[\s.-]+/)
    const rank = name.startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : -1
    if (rank >= 0) hits.push({ name, rank })
  }
  return hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).slice(0, limit).map((h) => h.name)
}

// every character name the project knows: its character sheet, the scene list, and who speaks in the written scenes
export function collectCharacterNames({ sheetNames = [], sceneListNames = [], drafts = [] }) {
  const set = new Set()
  const add = (n) => { const v = String(n ?? '').trim().toUpperCase(); if (v) set.add(v) }
  sheetNames.forEach(add)
  sceneListNames.forEach(add)
  drafts.forEach((d) => {
    ;(d?.charactersPresent ?? []).forEach(add)
    ;(d?.elements ?? []).forEach((e) => { if (e?.type === 'dialogue') add(e.character) })
  })
  return [...set].sort()
}
