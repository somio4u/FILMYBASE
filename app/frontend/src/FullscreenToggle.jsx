import { useEffect, useState } from 'react'

// Button that hides the browser's tabs and address bar (real full screen). Esc brings them back.
export default function FullscreenToggle() {
  const [full, setFull] = useState(() => Boolean(document.fullscreenElement))
  const supported = Boolean(document.documentElement.requestFullscreen)

  useEffect(() => {
    const sync = () => setFull(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  if (!supported) return null

  const toggle = () => {
    const job = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()
    job?.catch?.(() => {}) // the browser refused (for example inside a frame): stay as we are
  }

  return (
    <button type="button" className="fullscreen-toggle" aria-pressed={full}
      title={full ? 'Press Esc or tap to leave full screen' : 'Full screen — hides the browser tabs. Press Esc to come back.'}
      onClick={toggle}>
      {full ? '✕ Exit' : '⛶ Full screen'}
    </button>
  )
}
