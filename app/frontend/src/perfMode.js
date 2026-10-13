// Two display modes. "full" is the designed look (animated background, glow, motion). "light" is flat and still:
// no animation, no blur, no shadows, no moving background, so the app is quick on a phone or a slow computer.
// The choice is remembered on this device. First time, phones and small/slow devices start in Light.
import { useSyncExternalStore } from 'react'

const KEY = 'filmybase.perfMode'
const listeners = new Set()

function defaultMode() {
  try {
    const small = window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth < 820
    const slow = (navigator.hardwareConcurrency ?? 8) <= 4 || navigator.connection?.saveData
    return small || slow ? 'light' : 'full'
  } catch { return 'full' }
}

export function getPerfMode() {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'full') return saved
  } catch { /* private window: fall through */ }
  return defaultMode()
}

function apply(mode) {
  document.documentElement.dataset.perf = mode
}

export function setPerfMode(mode) {
  try { localStorage.setItem(KEY, mode) } catch { /* per-device convenience only */ }
  apply(mode)
  listeners.forEach((l) => l())
}

export function initPerfMode() { apply(getPerfMode()) }

export function usePerfMode() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => document.documentElement.dataset.perf || getPerfMode(),
    () => 'full',
  )
}
