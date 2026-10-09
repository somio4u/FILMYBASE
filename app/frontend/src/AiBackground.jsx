import { useEffect, useRef } from 'react'

// The animated "AI tunnel" behind the whole app: rings of glowing data
// glyphs slowly turning around a dark core, like a big AI quietly at work.
// While the app is waiting on the AI (any save / generate / rewrite request,
// see the fetch patch in App.jsx), the rings speed up and the core glows.
//
// Drawn on one canvas: each glyph is a pre-rendered glowing sprite, so a
// frame is just a few hundred drawImage calls. Paused while the tab is
// hidden; a single still frame for people who ask for reduced motion.

export const AI_ACTIVITY_EVENT = 'filmybase:ai-activity'

const GLYPHS = ['square', 'square', 'square', 'bar', 'zero', 'one']

function makeSprite(kind, size) {
  const pad = Math.ceil(size * 0.9)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size + pad * 2
  const ctx = canvas.getContext('2d')
  ctx.translate(pad, pad)
  ctx.strokeStyle = 'rgb(120, 230, 255)'
  ctx.fillStyle = 'rgb(120, 230, 255)'
  ctx.shadowColor = 'rgb(40, 200, 255)'
  ctx.shadowBlur = size * 0.8
  ctx.lineWidth = Math.max(1.2, size * 0.14)
  if (kind === 'square') {
    ctx.strokeRect(size * 0.12, size * 0.12, size * 0.76, size * 0.76)
  } else if (kind === 'bar') {
    ctx.fillRect(size * 0.1, size * 0.4, size * 0.8, size * 0.2)
  } else {
    ctx.font = `600 ${size}px "Courier Prime", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(kind === 'zero' ? '0' : '1', size / 2, size / 2)
  }
  return { canvas, offset: pad + size / 2 }
}

function buildRings(width, height) {
  const maxRadius = Math.hypot(width, height) / 2
  // Fewer glyphs on small screens.
  const density = Math.min(1, (width * height) / (1440 * 900))
  const rings = []
  const count = 11
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1)
    const radius = maxRadius * (0.1 + Math.pow(t, 1.25) * 0.95)
    const glyphSize = 4 + t * 13
    const glyphCount = Math.max(16, Math.round((2 * Math.PI * radius) / (glyphSize * 1.9) * (0.35 + 0.55 * density)))
    const glyphs = []
    for (let g = 0; g < glyphCount; g++) {
      glyphs.push({
        angle: (g / glyphCount) * Math.PI * 2 + Math.random() * 0.04,
        drift: (Math.random() - 0.5) * glyphSize * 2.2,
        kind: Math.floor(Math.random() * GLYPHS.length),
        twinkle: Math.random() * Math.PI * 2,
        base: 0.25 + Math.random() * 0.75,
        present: Math.random() < 0.82,
      })
    }
    rings.push({
      radius,
      glyphSize,
      glyphs,
      speed: (0.012 + Math.random() * 0.02) * (i % 2 === 0 ? 1 : -1),
      angle: Math.random() * Math.PI * 2,
      arcs: Array.from({ length: 2 + Math.floor(Math.random() * 3) }, () => ({
        start: Math.random() * Math.PI * 2,
        length: 0.3 + Math.random() * 1.1,
        offset: (Math.random() < 0.5 ? -1 : 1) * glyphSize * (1.4 + Math.random()),
      })),
      sprites: GLYPHS.map((kind) => makeSprite(kind, Math.round(glyphSize))),
    })
  }
  return rings
}

export default function AiBackground() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let width = 0
    let height = 0
    let rings = []
    let frame = null
    let last = performance.now()
    let busyRequests = 0
    let busy = 0 // eased 0 → 1 while the AI is working

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      rings = buildRings(width, height)
    }

    function draw(now) {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      busy += ((busyRequests > 0 ? 1 : 0) - busy) * Math.min(1, dt * 2.5)
      const speed = 1 + busy * 3
      const cx = width / 2
      const cy = height / 2

      const backdrop = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(width, height) / 2)
      backdrop.addColorStop(0, '#010414')
      backdrop.addColorStop(0.45, '#04133a')
      backdrop.addColorStop(1, '#010612')
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.fillStyle = backdrop
      ctx.fillRect(0, 0, width, height)

      ctx.globalCompositeOperation = 'lighter'
      const seconds = now / 1000
      for (const ring of rings) {
        ring.angle += ring.speed * dt * speed
        // Thin arc lines that hug the ring, like the guide lines in a HUD.
        ctx.strokeStyle = `rgba(70, 190, 255, ${0.2 + busy * 0.15})`
        ctx.lineWidth = 1
        for (const arc of ring.arcs) {
          ctx.beginPath()
          ctx.arc(cx, cy, ring.radius + arc.offset, ring.angle + arc.start, ring.angle + arc.start + arc.length)
          ctx.stroke()
        }
        for (const glyph of ring.glyphs) {
          if (!glyph.present) continue
          const flicker = 0.55 + 0.45 * Math.sin(seconds * (1.3 + busy * 2.5) + glyph.twinkle)
          ctx.globalAlpha = Math.min(1, glyph.base * flicker * (0.62 + busy * 0.38))
          const angle = ring.angle + glyph.angle
          const r = ring.radius + glyph.drift
          const sprite = ring.sprites[glyph.kind]
          ctx.drawImage(sprite.canvas, cx + Math.cos(angle) * r - sprite.offset, cy + Math.sin(angle) * r - sprite.offset)
        }
      }

      // The core: dark, with a soft pulse that grows while the AI works.
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      const coreRadius = Math.min(width, height) * 0.16
      const pulse = 0.5 + 0.5 * Math.sin(seconds * (1.2 + busy * 3))
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius * (1.4 + busy * 0.4))
      core.addColorStop(0, `rgba(1, 4, 22, ${0.9 - busy * 0.25})`)
      core.addColorStop(0.55, `rgba(20, 120, 255, ${0.04 + busy * (0.1 + pulse * 0.12)})`)
      core.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx, cy, coreRadius * (1.4 + busy * 0.4), 0, Math.PI * 2)
      ctx.fill()

      if (!reduceMotion) frame = requestAnimationFrame(draw)
    }

    function start() {
      if (frame || document.hidden) return
      last = performance.now()
      frame = requestAnimationFrame(draw)
    }
    function stop() {
      if (frame) cancelAnimationFrame(frame)
      frame = null
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    const onActivity = (event) => {
      busyRequests = Math.max(0, busyRequests + (event.detail?.delta ?? 0))
      if (reduceMotion) draw(performance.now())
    }

    resize()
    if (reduceMotion) draw(performance.now())
    else start()
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener(AI_ACTIVITY_EVENT, onActivity)
    return () => {
      stop()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener(AI_ACTIVITY_EVENT, onActivity)
    }
  }, [])

  return <canvas ref={canvasRef} className="ai-background" aria-hidden="true" />
}
