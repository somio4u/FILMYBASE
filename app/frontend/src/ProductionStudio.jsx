// The production workspaces of AI Movie, in the order the film is made:
//   Production Blueprint -> Image Studio -> Video Studio -> Audio Studio -> Timeline -> Export & Delivery
// Every one of them shows the same project header (versions, counts, approvals, running jobs, money), and every one of
// them reads the same Shot Manifest, so the numbers can never disagree between screens.

import { useCallback, useEffect, useState } from 'react'
import Blueprint from './Blueprint.jsx'
import TimelineView from './TimelineView.jsx'
import ImageStudio from './ImageStudio.jsx'
import { VideoStudio, AudioStudio } from './VideoAudioStudio.jsx'
import PipelineStage from './PipelineStage.jsx'
import ExportDelivery from './ExportDelivery.jsx'
import { useLive } from './useLive.js'
import './Production.css'

export const PRODUCTION_WORKSPACES = {
  storyboardDesigner: { title: 'Storyboard Designer', intro: 'Takes only the locked screenplay and turns it into the storyboard: every scene is divided into shots. Nothing else happens here — the pictures come next, in the Image Studio.' },
  blueprint: { title: 'Production Blueprint', intro: 'Plan everything before anything is generated: assets, shots with lengths, and every prompt. Approving it creates the Timeline.' },
  imageStudio: { title: 'Image Studio', intro: 'Characters, Environments, Properties and Shot Frames: generate, compare and approve the pictures the film is made from.' },
  videoStudio: { title: 'Video Studio', intro: 'Make video from each approved first frame, compare the takes and approve one.' },
  audioStudio: { title: 'Audio Studio', intro: 'Dialogue voices, sound effects and music, tied to the lines and shots they belong to.' },
  timeline: { title: 'Timeline', intro: 'The whole film laid out shot by shot. Approved media fills the blocks in by itself.' },
  export: { title: 'Export & Delivery', intro: 'Render the rough cut and the edit package from the timeline.' },
}
// The older screen names keep working (saved state, links): they open the new workspace that contains them.
export const LEGACY_VIEW = { shots: 'storyboardDesigner', storyboard: 'storyboardDesigner', images: 'imageStudio', video: 'videoStudio', audio: 'audioStudio', dossier: 'storyboardDesigner' }

const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`

async function getJson(url) {
  try {
    const r = await fetch(url)
    return r.ok ? await r.json() : null
  } catch { return null }
}

function ProjectHeader({ projectId, backendUrl }) {
  const [manifest, setManifest] = useState(null)
  const [pipeline, setPipeline] = useState(null)
  const load = useCallback(async () => {
    const [m, p] = await Promise.all([getJson(`${backendUrl}/api/production/${projectId}/manifest`), getJson(`${backendUrl}/api/production/${projectId}/pipeline`)])
    if (m) setManifest(m)
    if (p) setPipeline(p)
  }, [backendUrl, projectId])
  useEffect(() => { load() }, [load])
  useLive(projectId, backendUrl, load)
  if (!manifest) return null
  const t = manifest.totals
  const spend = pipeline?.spend
  const pct = spend && spend.limitUsd > 0 ? Math.min(100, Math.round((spend.spentUsd / spend.limitUsd) * 100)) : 0
  const chip = (label, value, title, done) => <span className={`ph-chip${done ? ' done' : ''}`} title={title}><span>{label}</span> <strong>{value}</strong></span>
  return (
    <section className="ph" aria-label="Project status">
      <div className="ph-row">
        {chip('Screenplay', `v${manifest.screenplay_version ?? '—'}`, 'The approved screenplay version production is planned from')}
        {chip('Blueprint', manifest.blueprint ? `v${manifest.blueprint.version} ${manifest.blueprint.status}` : 'not started', 'The production plan', manifest.blueprint?.status === 'approved')}
        {chip('Scenes', t.scenes)}
        {chip('Shots', t.shots)}
        {chip('Characters', `${t.assets.characters} in project · ${t.approved_references.characters} approved sheets`, 'Characters in the project, and how many have an approved reference sheet', t.assets.characters > 0 && t.approved_references.characters >= t.assets.characters)}
        {chip('Environments', `${t.assets.environments} · ${t.approved_references.environments} approved`, 'Environments in the project, and approved reference sheets', t.assets.environments > 0 && t.approved_references.environments >= t.assets.environments)}
        {chip('Properties', `${t.assets.props} · ${t.approved_references.props} approved`, 'Properties in the project, and approved reference sheets', t.assets.props > 0 && t.approved_references.props >= t.assets.props)}
        {chip('First frames', `${t.first_frames_approved}/${t.shots}`, 'Shots with an approved first frame', t.shots > 0 && t.first_frames_approved >= t.shots)}
        {chip('Videos', `${t.videos_approved}/${t.shots}`, 'Shots with an approved video take', t.shots > 0 && t.videos_approved >= t.shots)}
        {chip('Voices', `${t.audio_approved}/${t.dialogue_lines}`, 'Spoken lines with an approved voice', t.dialogue_lines > 0 && t.audio_approved >= t.dialogue_lines)}
        {chip('Jobs running', t.jobs_running, 'Pictures, voices or videos being made right now')}
      </div>
      {spend && (
        <div className="ph-money">
          <span>Money: {usd(spend.spentUsd)} of {usd(spend.limitUsd)}</span>
          <span className="pipe-meter" aria-hidden="true"><span className={pct >= 90 ? 'hot' : ''} style={{ width: `${pct}%` }} /></span>
        </div>
      )}
    </section>
  )
}

// STORYBOARD DESIGNER: the one place shots are made. Adu never cuts shots by himself; he does it only when this button is
// pressed (Cinematic Director directions first, then every scene is cut), and then waits for the director's approval.
function CreateShotDivision({ projectId, backendUrl }) {
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const loadJob = useCallback(async () => {
    const data = await getJson(`${backendUrl}/api/ai-movie/projects/${projectId}/auto-production`)
    setJob(data?.job ?? null)
    return data?.job ?? null
  }, [backendUrl, projectId])
  useEffect(() => { loadJob() }, [loadJob])
  const running = job?.status === 'running'
  useEffect(() => {
    if (!running && !busy) return undefined
    const timer = setInterval(async () => {
      const next = await loadJob()
      if (next && next.status !== 'running') setBusy(false)
    }, 4000)
    return () => clearInterval(timer)
  }, [running, busy, loadJob])

  async function create() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${backendUrl}/api/ai-movie/projects/${projectId}/storyboard/create-shots`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not start.')
      if (!data.started) setError('Adu is already working on this project — wait a moment.')
    } catch (e) {
      setError(e.message)
      setBusy(false)
      return
    }
    await loadJob()
  }

  const working = running || busy
  return (
    <section className="dossier-card" style={{ margin: '12px 0' }}>
      <button type="button" className="choose-button" onClick={create} disabled={working}>
        {working ? 'Adu is creating the shot division…' : '🎬 Create shot division from screenplay'}
      </button>
      <p className="dossier-fine-print">Adu reads the locked screenplay and cuts every scene into shots. Scenes that already have shots are left as they are. Nothing is approved for you — check the shots below (add, remove, combine or edit) and approve each scene; approved scenes then appear in the Image Studio.</p>
      {working && job?.phase === 'shots' && <p className="floating-agent-stage-line"><span className="floating-agent-spinner" aria-hidden="true" /><span>Step {job.step ?? 1} of {job.steps ?? 4}: {job.label}{job.detail ? ` (${job.detail})` : ''}</span></p>}
      {error && <p className="dossier-error">{error}</p>}
      {!working && job?.phase === 'shots' && (job.status === 'failed' || job.status === 'needs_attention') && <p className="dossier-error">{job.message}</p>}
      {!working && job?.phase === 'shots' && job.status === 'waiting_for_you' && <p className="dossier-message">{job.message}</p>}
    </section>
  )
}

export default function ProductionStudio({ workspace, projectId, backendUrl, onNavigate }) {
  if (!projectId) return <p className="dossier-note">Open or create an AI Movie project first.</p>
  const info = PRODUCTION_WORKSPACES[workspace]
  return (
    <div className="dossier ps" key={`${workspace}-${projectId}`}>
      <header className="dossier-header"><div><h2>{info.title}</h2><p className="dossier-fine-print">{info.intro}</p></div></header>
      <ProjectHeader projectId={projectId} backendUrl={backendUrl} />
      {workspace === 'storyboardDesigner' && (
        <>
          <CreateShotDivision projectId={projectId} backendUrl={backendUrl} />
          <PipelineStage stage="shots" projectId={projectId} backendUrl={backendUrl} />
        </>
      )}
      {workspace === 'blueprint' && <Blueprint projectId={projectId} backendUrl={backendUrl} onNavigate={onNavigate} />}
      {workspace === 'timeline' && <TimelineView projectId={projectId} backendUrl={backendUrl} onNavigate={onNavigate} />}
      {workspace === 'imageStudio' && <ImageStudio projectId={projectId} backendUrl={backendUrl} />}
      {workspace === 'videoStudio' && <VideoStudio projectId={projectId} backendUrl={backendUrl} onNavigate={onNavigate} />}
      {workspace === 'audioStudio' && <AudioStudio projectId={projectId} backendUrl={backendUrl} />}
      {workspace === 'export' && (
        <>
          <ExportDelivery projectId={projectId} backendUrl={backendUrl} onNavigate={onNavigate} />
          <details className="ps-classic">
            <summary>Classic scene-by-scene export (older tool, kept as it was)</summary>
            <PipelineStage stage="export" projectId={projectId} backendUrl={backendUrl} />
          </details>
        </>
      )}
    </div>
  )
}
