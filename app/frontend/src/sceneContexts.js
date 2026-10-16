// "Add multiple scenes": the writer types what happens in each scene in one box. This cuts the box into one text per scene.
//   - lines that start with a number ("1." "2)" "3-" "Scene 4:") start a new scene
//   - otherwise a blank line between paragraphs separates the scenes
//   - otherwise it is ONE scene (a single paragraph is never cut up)
// Whatever the writer wrote is kept word for word: it is the only story the AI may use for that scene.

const NUMBERED = /^\s*(?:scene\s*)?\d{1,3}\s*[.):\-–—]\s*(.*)$/i

export function splitSceneContexts(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n')
  const numberedStarts = lines.filter((l) => NUMBERED.test(l)).length
  let parts = []
  if (numberedStarts >= 2 || (numberedStarts === 1 && NUMBERED.test(lines.find((l) => l.trim()) ?? ''))) {
    let current = null
    for (const line of lines) {
      const m = line.match(NUMBERED)
      if (m) { if (current !== null) parts.push(current); current = m[1] }
      else if (current !== null) current += `\n${line}`
      else if (line.trim()) current = line // text before the first number
    }
    if (current !== null) parts.push(current)
  } else {
    parts = lines.join('\n').split(/\n\s*\n/)
  }
  return parts.map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).slice(0, 30)
}
