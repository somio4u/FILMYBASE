// The screenplay page as ONE editable document (like Word / Final Draft): click anywhere and type, select across lines, copy, paste.
// Every line has a type (action, character, parenthetical, dialogue, transition, flashback). Enter makes the next logical line
// (CHARACTER -> dialogue, dialogue -> action), Tab changes the type of the line, and while a CHARACTER line is typed the project's
// names are offered. The saved elements are rebuilt from the lines after every change (see scriptDoc.js).
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { LINE_TYPES, MODIFIERS, cycleType, elementsFromLines, linesFromElements, matchNames, nextType, splitModifier } from './scriptDoc.js'

const ZERO = '​'

function makeLine(line) {
  const p = document.createElement('p')
  p.dataset.t = LINE_TYPES.includes(line.t) ? line.t : 'action'
  if (line.ch) p.dataset.ch = line.ch
  if (line.glow) p.classList.add('is-voice-new')
  setText(p, line.text ?? '')
  return p
}

function setText(p, text) {
  p.textContent = text
  if (text === '') p.appendChild(document.createElement('br'))
}

const textOf = (p) => p.textContent.split(ZERO).join('')

function ScriptEditor({ elements, version, glow, focusAt, names, onChange, onCursor, onActiveType, onSave }, ref) {
  const rootRef = useRef(null)
  const mapRef = useRef([])
  const [menu, setMenu] = useState(null) // { items, index, typed, top, left }
  const latest = useRef({ names, onChange, onCursor, onActiveType, onSave })
  latest.current = { names, onChange, onCursor, onActiveType, onSave }

  const lineOf = useCallback(() => {
    const root = rootRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return null
    let n = sel.anchorNode
    if (n === root) return root.children[Math.min(sel.anchorOffset, root.children.length - 1)] ?? null
    while (n && n.parentNode !== root) n = n.parentNode
    return n && n.nodeName === 'P' ? n : null
  }, [])

  const caretOffset = (p) => {
    const sel = window.getSelection()
    if (!sel.rangeCount) return 0
    const range = sel.getRangeAt(0).cloneRange()
    range.selectNodeContents(p)
    range.setEnd(sel.anchorNode, sel.anchorOffset)
    return range.toString().split(ZERO).join('').length
  }

  const setCaret = (p, offset) => {
    const sel = window.getSelection()
    const range = document.createRange()
    const node = p.firstChild
    if (!node || node.nodeName === 'BR') { range.setStart(p, 0) } else {
      let left = offset
      let walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      let target = null
      while (walker.nextNode()) {
        const len = walker.currentNode.nodeValue.length
        if (left <= len) { target = walker.currentNode; break }
        left -= len
      }
      if (target) range.setStart(target, left); else { range.selectNodeContents(p); range.collapse(false) }
    }
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    p.scrollIntoView({ block: 'nearest' })
  }

  // keep the page made only of <p data-t> lines whatever the browser does on its own (delete across lines, drag, undo)
  const fixStructure = () => {
    const root = rootRef.current
    let changed = false
    if (root.children.length === 0 || root.childNodes.length === 0) { root.replaceChildren(makeLine({ t: 'action', text: '' })); return true }
    let prevType = 'action'
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeName === 'P' && node.dataset.t) {
        if (Array.from(node.childNodes).some((c) => c.nodeType === 1 && c.nodeName !== 'BR')) { setText(node, node.textContent); changed = true }
        prevType = node.dataset.t
        continue
      }
      const p = makeLine({ t: prevType === 'character' ? 'dialogue' : prevType, text: node.textContent ?? '' })
      node.replaceWith(p)
      changed = true
    }
    return changed
  }

  const readLines = () => Array.from(rootRef.current.children).map((p) => ({ t: p.dataset.t || 'action', text: textOf(p), ch: p.dataset.ch }))

  const sync = useCallback(() => {
    const { elements: els, lineToElement } = elementsFromLines(readLines())
    mapRef.current = lineToElement
    latest.current.onChange?.(els)
  }, [])

  const report = useCallback(() => {
    const p = lineOf()
    if (!p) return
    const index = Array.prototype.indexOf.call(rootRef.current.children, p)
    latest.current.onActiveType?.(p.dataset.t || 'action')
    const el = mapRef.current[index]
    latest.current.onCursor?.(el === undefined ? null : el)
    if (p.dataset.t === 'character') {
      const typed = splitModifier(textOf(p)).name
      const items = matchNames(typed, latest.current.names)
      if (items.length > 0 && typed) {
        const rect = p.getBoundingClientRect()
        setMenu((prev) => ({ items, index: prev && prev.typed === typed ? Math.min(prev.index, items.length) : 0, typed, top: rect.bottom + 4, left: rect.left }))
        return
      }
    }
    setMenu(null)
  }, [lineOf])

  // build the page from the saved elements whenever a new version is handed in (opening a scene, voice lines)
  useLayoutEffect(() => {
    const root = rootRef.current
    const lines = linesFromElements(elements, glow)
    root.replaceChildren(...(lines.length ? lines : [{ t: 'action', text: '' }]).map(makeLine))
    mapRef.current = elementsFromLines(readLines()).lineToElement
    root.focus({ preventScroll: true })
    const target = focusAt && Number.isInteger(focusAt.el)
      ? Array.from(root.children).findIndex((_, i) => mapRef.current[i] === focusAt.el)
      : -1
    const p = root.children[target >= 0 ? target : (focusAt?.end === false ? 0 : root.children.length - 1)]
    if (p) setCaret(p, target >= 0 && !focusAt.start ? textOf(p).length : (focusAt?.end === false ? 0 : textOf(p).length))
    report()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  useEffect(() => {
    const onSel = () => { if (rootRef.current?.contains(window.getSelection()?.anchorNode)) report() }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [report])

  const changeType = (p, t) => {
    p.dataset.t = t
    if (t === 'character') setText(p, textOf(p).toUpperCase())
    if (t !== 'flashback') delete p.dataset.ch
    sync(); report()
    setCaret(p, textOf(p).length)
  }

  const chooseName = (name) => {
    const p = lineOf()
    if (!p) return
    const { modifier } = splitModifier(textOf(p))
    setText(p, `${name}${modifier ? ` (${modifier})` : ''}`)
    let next = p.nextElementSibling
    if (!next || next.dataset.t !== 'dialogue') {
      const fresh = makeLine({ t: 'dialogue', text: '' })
      p.after(fresh)
      next = fresh
    }
    setMenu(null)
    setCaret(next, textOf(next).length)
    sync(); report()
  }

  useImperativeHandle(ref, () => ({
    setType: (t) => { const p = lineOf() ?? rootRef.current.lastElementChild; if (p) changeType(p, t) },
    toggleModifier: (m) => {
      const p = lineOf()
      if (!p || p.dataset.t !== 'character') return
      const { name, modifier } = splitModifier(textOf(p))
      setText(p, modifier === m ? name : `${name} (${m})`)
      setCaret(p, textOf(p).length)
      sync()
    },
    focus: () => rootRef.current?.focus(),
  }))

  const splitAtCaret = (p, newType) => {
    const text = textOf(p)
    const off = caretOffset(p)
    setText(p, text.slice(0, off))
    const fresh = makeLine({ t: newType, text: text.slice(off) })
    p.after(fresh)
    setCaret(fresh, 0)
  }

  const onKeyDown = (event) => {
    if (event.nativeEvent.isComposing) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); latest.current.onSave?.(); return }
    if (menu) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setMenu({ ...menu, index: (menu.index + 1) % (menu.items.length + 1) }); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setMenu({ ...menu, index: (menu.index + menu.items.length) % (menu.items.length + 1) }); return }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); return }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        if (menu.index < menu.items.length) { chooseName(menu.items[menu.index]); return }
        setMenu(null)
        if (event.key === 'Tab') return
      }
    }
    const p = lineOf()
    if (!p) return
    if (event.key === 'Tab') { event.preventDefault(); changeType(p, cycleType(p.dataset.t, event.shiftKey)); return }
    if (event.key === 'Enter') {
      event.preventDefault()
      const sel = window.getSelection()
      if (!sel.isCollapsed) document.execCommand('delete')
      const here = lineOf() ?? p
      const text = textOf(here)
      // a second Enter on an empty speech line ends the speech
      if (here.dataset.t === 'dialogue' && text === '') { changeType(here, 'action'); return }
      const off = caretOffset(here)
      splitAtCaret(here, nextType(here.dataset.t, off < text.length))
      sync(); report()
    }
  }

  const onPaste = (event) => {
    event.preventDefault()
    const text = (event.clipboardData?.getData('text/plain') ?? '').replace(/\r/g, '')
    if (!text) return
    const sel = window.getSelection()
    if (!sel.isCollapsed) document.execCommand('delete')
    const parts = text.split('\n')
    if (parts.length === 1) { document.execCommand('insertText', false, text); return }
    const p = lineOf()
    if (!p) return
    const full = textOf(p)
    const off = caretOffset(p)
    const type = p.dataset.t === 'character' ? 'dialogue' : p.dataset.t
    setText(p, full.slice(0, off) + parts[0])
    let last = p
    parts.slice(1).forEach((part, i) => {
      const isLast = i === parts.length - 2
      const fresh = makeLine({ t: type, text: isLast ? part + full.slice(off) : part })
      last.after(fresh)
      last = fresh
    })
    setCaret(last, textOf(last).length - full.slice(off).length)
    sync(); report()
  }

  const onInput = () => {
    fixStructure()
    sync(); report()
  }

  return (
    <>
      <div
        ref={rootRef}
        className="script-doc"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline="true"
        aria-label="Screenplay"
        onKeyDown={onKeyDown}
        onInput={onInput}
        onPaste={onPaste}
        onDrop={(e) => e.preventDefault()}
        onBlur={() => setTimeout(() => setMenu(null), 150)}
      />
      {menu && (
        <ul className="script-name-menu" role="listbox" style={{ top: menu.top, left: menu.left }}>
          {menu.items.map((name, i) => (
            <li key={name} role="option" aria-selected={i === menu.index} className={i === menu.index ? 'is-active' : ''} onMouseDown={(e) => { e.preventDefault(); chooseName(name) }}>{name}</li>
          ))}
          <li role="option" aria-selected={menu.index === menu.items.length} className={`is-new${menu.index === menu.items.length ? ' is-active' : ''}`} onMouseDown={(e) => { e.preventDefault(); setMenu(null) }}>“{menu.typed.toUpperCase()}” — new</li>
        </ul>
      )}
    </>
  )
}

export default memo(forwardRef(ScriptEditor))
export { MODIFIERS, LINE_TYPES }

const TOOLBAR_LABELS = {
  en: {
    title: 'Writing tools', types: { action: 'Action', character: 'Character', parenthetical: 'Parenthetical', dialogue: 'Dialogue', transition: 'Transition', flashback: 'Flashback' },
    modifiers: 'After the character name', save: 'Save my changes', cancel: 'Cancel', saving: 'Saving…', unsaved: 'Unsaved changes',
    how: ['Click anywhere on the page and type — it works like Word.', 'Enter: next line (Character → Dialogue → Action). Tab: change the kind of the line.', 'On a Character line type a few letters — the project’s names appear; Enter picks one and moves to its dialogue.', 'Ctrl+S saves.'],
  },
  or: {
    title: 'ଲେଖିବା ଟୁଲ୍', types: { action: 'ଆକ୍ସନ୍', character: 'ଚରିତ୍ର', parenthetical: 'ପ୍ୟାରେନ୍ଥେଟିକାଲ୍', dialogue: 'ଡାଇଲଗ୍', transition: 'ଟ୍ରାନଜିସନ୍', flashback: 'ଫ୍ଲାସବ୍ୟାକ୍' },
    modifiers: 'ଚରିତ୍ର ନାମ ପରେ', save: 'ମୋ ଚେଞ୍ଜ ସେଭ୍ କର', cancel: 'ବାତିଲ୍', saving: 'ସେଭ୍ ହେଉଛି…', unsaved: 'ସେଭ୍ ହୋଇନି',
    how: ['ପେଜ୍‌ରେ ଯେକୌଣସି ଜାଗାରେ କ୍ଲିକ୍ କରି ଲେଖ — Word ପରି।', 'Enter: ପରବର୍ତ୍ତୀ ଲାଇନ୍ (ଚରିତ୍ର → ଡାଇଲଗ୍ → ଆକ୍ସନ୍)। Tab: ଲାଇନ୍‌ର ପ୍ରକାର ବଦଳାଅ।', 'ଚରିତ୍ର ଲାଇନ୍‌ରେ କିଛି ଅକ୍ଷର ଲେଖ — ପ୍ରୋଜେକ୍ଟର ନାମ ଦେଖାଯିବ; Enter ଦବାଇଲେ ଡାଇଲଗ୍‌କୁ ଯିବ।', 'Ctrl+S ସେଭ୍ କରେ।'],
  },
}

// the writing tools in the right-hand panel: the kind of the line the cursor is in, the (V.O.) type endings, save
export function ScriptToolbar({ editorRef, activeType, lang = 'en', onSave, onCancel, saving, dirty }) {
  const L = TOOLBAR_LABELS[lang] ?? TOOLBAR_LABELS.en
  // the buttons must not take the cursor out of the page
  const keep = (event) => event.preventDefault()
  return (
    <div className="script-toolbar" role="toolbar" aria-label={L.title}>
      <p className="script-toolbar-title">{L.title}{dirty ? <span className="script-toolbar-dirty"> · {L.unsaved}</span> : null}</p>
      <div className="script-toolbar-types">
        {LINE_TYPES.map((type) => (
          <button key={type} type="button" className={activeType === type ? 'is-active' : ''} aria-pressed={activeType === type} onMouseDown={keep} onClick={() => editorRef.current?.setType(type)}>{L.types[type]}</button>
        ))}
      </div>
      <p className="script-toolbar-sub">{L.modifiers}</p>
      <div className="script-toolbar-mods">
        {MODIFIERS.map((m) => <button key={m} type="button" disabled={activeType !== 'character'} onMouseDown={keep} onClick={() => editorRef.current?.toggleModifier(m)}>({m})</button>)}
      </div>
      <ul className="script-toolbar-how">{L.how.map((line) => <li key={line}>{line}</li>)}</ul>
      <div className="script-toolbar-actions">
        <button type="button" className="cancel-button" onClick={onCancel} disabled={saving}>{L.cancel}</button>
        <button type="button" className="choose-button" onClick={onSave} disabled={saving}>{saving ? L.saving : L.save}</button>
      </div>
    </div>
  )
}
