// One top-level production stage (Storyboard, Image generation, Audio, Video,
// Assemble & export), each with its own tab bar like the Story / Screenplay
// stages, and sub-tabs inside (e.g. Image generation: Characters / Props /
// Environments / Shot pictures).
import { useCallback, useEffect, useState } from 'react'
import './ProductionDossier.css'
import { PipelineBar, ShotsPanel, ArtPanel, FramesPanel, VoicePanel, VideoPanel, ExportPanel } from './PipelinePanels.jsx'

export const PIPELINE_STAGES = {
  storyboard: { title: 'Storyboard', intro: 'Cut each scene into shots, then write the text storyboard (no pictures).' },
  images: { title: 'Image generation', intro: 'Make reference pictures (characters first, then props, then environments), then one picture per shot.' },
  audio: { title: 'Audio', intro: 'Make a voice for every dialogue line.' },
  video: { title: 'Video', intro: 'Make video takes from the approved shot pictures and choose the best one.' },
  export: { title: 'Assemble & export', intro: 'Join the approved video, pictures and voices into a rough cut and an edit package.' },
}

export default function PipelineStage({ stage, projectId, backendUrl }) {
  const api = `${backendUrl}/api/production`
  const [pipeline, setPipeline] = useState(null)
  const [assets, setAssets] = useState([])
  const [sceneId, setSceneId] = useState(null)
  const [sub, setSub] = useState({})

  const reloadPipeline = useCallback(async () => {
    try {
      const response = await fetch(`${api}/${projectId}/pipeline`)
      if (response.ok) setPipeline(await response.json())
    } catch { /* the strip stays hidden */ }
  }, [api, projectId])
  useEffect(() => {
    setSceneId(null)
    reloadPipeline()
    fetch(`${api}/${projectId}/assets`).then((r) => (r.ok ? r.json() : { assets: [] })).then((d) => setAssets(d.assets)).catch(() => {})
  }, [api, projectId, reloadPipeline])

  const st = pipeline?.status
  const ref = (key) => (st ? `${st.references[key].approved}/${st.references[key].total}` : '')
  const tabs = {
    storyboard: [
      { key: 'shots', label: 'Shot division', count: st ? `${st.shots.total} shots` : '' },
      { key: 'text', label: 'Text storyboard', count: st ? `${st.shots.storyboardApproved}/${st.shots.total} approved` : '' },
    ],
    images: [
      { key: 'character', label: 'Characters', count: ref('characters') },
      { key: 'prop', label: 'Props', count: ref('props') },
      { key: 'other', label: 'Other items', count: '' },
      { key: 'location', label: 'Environments', count: ref('environments') },
      { key: 'frames', label: 'Shot pictures', count: st ? `${st.keyframes.approved}/${st.keyframes.of}` : '' },
    ],
    audio: [{ key: 'voices', label: 'Dialogue voices', count: st ? `${st.audio.approved}/${st.audio.of}` : '' }],
    video: [{ key: 'takes', label: 'Video takes', count: st ? `${st.video.approved}/${st.video.of}` : '' }],
    export: [{ key: 'assemble', label: 'Rough cut & edit package', count: '' }],
  }[stage]
  const current = sub[stage] ?? tabs[0].key
  const shared = { projectId, api, backendUrl, pipeline, onChanged: reloadPipeline }
  const scene = { sceneId, onSceneChange: setSceneId }

  if (!projectId) return <p className="dossier-note">Open or create an AI Movie project first.</p>
  return (
    <div className="dossier">
      <header className="dossier-header">
        <div>
          <h2>{PIPELINE_STAGES[stage].title}</h2>
          <p className="dossier-fine-print">{PIPELINE_STAGES[stage].intro}</p>
        </div>
      </header>
      <PipelineBar pipeline={pipeline} api={api} projectId={projectId} onSaved={reloadPipeline} />
      {tabs.length > 1 && (
        <nav className="dossier-tabs" aria-label={`${PIPELINE_STAGES[stage].title} sections`}>
          {tabs.map((t) => (
            <button key={t.key} type="button" className={current === t.key ? 'dossier-tab active' : 'dossier-tab'} onClick={() => setSub({ ...sub, [stage]: t.key })}>
              {t.label}{t.count ? <span className="dossier-tab-count"> {t.count}</span> : null}
            </button>
          ))}
        </nav>
      )}
      {stage === 'storyboard' && <ShotsPanel {...shared} {...scene} section={current} />}
      {stage === 'images' && (current === 'frames'
        ? <FramesPanel {...shared} {...scene} />
        : <ArtPanel {...shared} assets={assets} only={current} />)}
      {stage === 'audio' && <VoicePanel {...shared} {...scene} />}
      {stage === 'video' && <VideoPanel {...shared} {...scene} />}
      {stage === 'export' && <ExportPanel projectId={projectId} api={api} backendUrl={backendUrl} {...scene} />}
    </div>
  )
}
