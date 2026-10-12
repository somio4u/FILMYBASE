// The production workspaces of AI Movie, in the order the film is made:
//   Production Blueprint -> Image Studio -> Video Studio -> Audio Studio -> Timeline -> Export & Delivery
// Every one of them shows the same project header (versions, counts, approvals, running jobs, money), and every one of
// them reads the same Shot Manifest, so the numbers can never disagree between screens.

import { useCallback, useEffect, useState } from 'react'
import Blueprint from './Blueprint.jsx'
import TimelineView from './TimelineView.jsx'
import ImageStudio from './ImageStudio.jsx'
import PipelineStage from './PipelineStage.jsx'
import { useLive } from './useLive.js'
import './Production.css'

export const PRODUCTION_WORKSPACES = {
  blueprint: { title: 'Production Blueprint', intro: 'Plan everything before anything is generated: assets, shots with lengths, and every prompt. Approving it creates the Timeline.' },
  imageStudio: { title: 'Image Studio', intro: 'Characters, Environments, Properties and Shot Frames: generate, compare and approve the pictures the film is made from.' },
  videoStudio: { title: 'Video Studio', intro: 'Make video from each approved first frame, compare the takes and approve one.' },
  audioStudio: { title: 'Audio Studio', intro: 'Dialogue voices, sound effects and music, tied to the lines and shots they belong to.' },
  timeline: { title: 'Timeline', intro: 'The whole film laid out shot by shot. Approved media fills the blocks in by itself.' },
  export: { title: 'Export & Delivery', intro: 'Render the rough cut and the edit package from the timeline.' },
}
// The older screen names keep working (saved state, links): they open the new workspace that contains them.
export const LEGACY_VIEW = { shots: 'blueprint', storyboard: 'blueprint', images: 'imageStudio', video: 'videoStudio', audio: 'audioStudio', dossier: 'blueprint' }

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

export default function ProductionStudio({ workspace, projectId, backendUrl, onNavigate }) {
  if (!projectId) return <p className="dossier-note">Open or create an AI Movie project first.</p>
  const info = PRODUCTION_WORKSPACES[workspace]
  return (
    <div className="dossier ps" key={`${workspace}-${projectId}`}>
      <header className="dossier-header"><div><h2>{info.title}</h2><p className="dossier-fine-print">{info.intro}</p></div></header>
      <ProjectHeader projectId={projectId} backendUrl={backendUrl} />
      {workspace === 'blueprint' && <Blueprint projectId={projectId} backendUrl={backendUrl} onNavigate={onNavigate} />}
      {workspace === 'timeline' && <TimelineView projectId={projectId} backendUrl={backendUrl} onNavigate={onNavigate} />}
      {workspace === 'imageStudio' && <ImageStudio projectId={projectId} backendUrl={backendUrl} />}
      {workspace === 'videoStudio' && <PipelineStage stage="video" projectId={projectId} backendUrl={backendUrl} />}
      {workspace === 'audioStudio' && <PipelineStage stage="audio" projectId={projectId} backendUrl={backendUrl} />}
      {workspace === 'export' && <PipelineStage stage="export" projectId={projectId} backendUrl={backendUrl} />}
    </div>
  )
}
