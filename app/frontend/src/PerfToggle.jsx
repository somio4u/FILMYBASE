import { setPerfMode, usePerfMode } from './perfMode.js'

// Top-right switch between Full mode (the designed look) and Light mode (flat, no animation, very light).
export default function PerfToggle() {
  const mode = usePerfMode()
  const light = mode === 'light'
  return (
    <button
      type="button"
      className="perf-toggle"
      aria-pressed={light}
      title={light ? 'Light mode is on — tap for Full mode' : 'Full mode is on — tap for Light mode'}
      onClick={() => setPerfMode(light ? 'full' : 'light')}
    >
      {light ? 'Light mode' : 'Full mode'}
    </button>
  )
}
