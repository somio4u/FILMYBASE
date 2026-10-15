// The VISUAL STYLE of the film (realistic, cartoon, anime, ...), chosen once for the whole project. It is written into every
// picture command: character, environment and property sheets, shot frames and videos.
import { useCallback, useEffect, useState } from 'react'

async function call(url, method = 'GET', body) {
  try {
    const response = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ok: response.ok, data: await response.json().catch(() => ({})) }
  } catch {
    return { ok: false, data: { error: 'Could not reach the server.' } }
  }
}

export default function StylePicker({ api, projectId, onChanged }) {
  const [styles, setStyles] = useState([])
  const [style, setStyle] = useState(null)
  const [custom, setCustom] = useState('')
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await call(`${api}/${projectId}/pipeline`)
    if (!r.ok) return
    setStyles(r.data.visualStyles ?? [])
    setStyle(r.data.settings?.visualStyle ?? 'realistic')
    setCustom(r.data.settings?.customStylePrompt ?? '')
  }, [api, projectId])
  useEffect(() => { load() }, [load])

  async function save(nextStyle, nextCustom) {
    setBusy(true)
    setMessage(null)
    const r = await call(`${api}/${projectId}/settings`, 'PATCH', { visualStyle: nextStyle, ...(nextStyle === 'custom' ? { stylePrompt: nextCustom } : {}) })
    setBusy(false)
    if (!r.ok) { setMessage({ tone: 'bad', text: r.data.error || 'Could not save the style.' }); await load(); return }
    setStyle(r.data.settings.visualStyle)
    setMessage({ tone: 'good', text: 'Style saved for characters, environments, properties and shots. Every picture command was updated. Pictures you already made keep their old look — press “Make another version” on any you want in the new style.' })
    onChanged?.()
  }

  if (style === null) return null
  return (
    <section className="studio-card" aria-label="Visual style of the film">
      <h3>🎨 Visual style of the film</h3>
      <p className="dossier-fine-print">One choice for the whole film. It is used for every character, environment, property and shot.</p>
      <div className="pipe-toolbar">
        <label className="studio-field">Style
          <select value={style} disabled={busy} onChange={(e) => { const v = e.target.value; setStyle(v); if (v !== 'custom') save(v, custom) }}>
            {styles.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            <option value="custom">Custom — describe it yourself</option>
          </select>
        </label>
      </div>
      {style === 'custom' && (
        <>
          <textarea className="studio-idea" rows={3} maxLength={2000} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. warm 1970s Odia village film, grainy colour, soft sunlight" />
          <button type="button" className="dossier-small-button" disabled={busy || !custom.trim()} onClick={() => save('custom', custom)}>Use this look</button>
        </>
      )}
      {message && <p className={message.tone === 'bad' ? 'dossier-error' : 'dossier-message'} role={message.tone === 'bad' ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  )
}
