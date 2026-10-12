// Live updates for a project: listens to the server's event stream and calls `onChange` (debounced) when something that
// matters changed, so a screen refetches just what it shows. If the stream cannot connect, it falls back to polling every
// few seconds — the database is the truth, the stream only makes it feel instant.
import { useEffect, useRef, useState } from 'react'

export function useLive(projectId, backendUrl, onChange, { fallbackMs = 8000 } = {}) {
  const [connected, setConnected] = useState(false)
  const handler = useRef(onChange)
  handler.current = onChange
  useEffect(() => {
    if (!projectId) return undefined
    let timer = null
    let poll = null
    const fire = () => { clearTimeout(timer); timer = setTimeout(() => handler.current?.(), 250) }
    let source = null
    try {
      source = new EventSource(`${backendUrl}/api/production/${projectId}/events`, { withCredentials: true })
      source.onopen = () => { setConnected(true); clearInterval(poll); poll = null }
      source.onmessage = (e) => { try { if (JSON.parse(e.data).type !== 'hello') fire() } catch { fire() } }
      source.onerror = () => {
        setConnected(false)
        if (!poll) poll = setInterval(() => handler.current?.(), fallbackMs)
      }
    } catch {
      poll = setInterval(() => handler.current?.(), fallbackMs)
    }
    return () => { clearTimeout(timer); clearInterval(poll); source?.close() }
  }, [projectId, backendUrl, fallbackMs])
  return connected
}
