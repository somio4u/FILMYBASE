// The designer brief, shown the same way to the reviewer and to the designer:
// MUST KEEP / DESIGNER MAY EXPLORE / NEEDS DECISION, then what to deliver.

function BriefSection({ tone, title, subtitle, children, empty }) {
  return (
    <section className={`dossier-brief-section brief-${tone}`}>
      <h4>{title}</h4>
      <p className="dossier-fine-print">{subtitle}</p>
      {children ?? <p className="dossier-fine-print">{empty}</p>}
    </section>
  )
}

export default function TaskBrief({ brief }) {
  return (
    <>
      <BriefSection tone="keep" title="MUST KEEP" subtitle="Facts from the screenplay and decisions a person confirmed. Do not change these.">
        {brief.mustKeep.length > 0 && (
          <ul>
            {brief.mustKeep.map((m, i) => (
              <li key={i}><strong>{m.label}:</strong> {m.text} <span className="dossier-fine-print">({m.source})</span></li>
            ))}
          </ul>
        )}
      </BriefSection>

      <BriefSection tone="explore" title="DESIGNER MAY EXPLORE" subtitle="The screenplay leaves these open. Decide them in your design." empty="Nothing left open.">
        {brief.mayExplore.length > 0 && <ul>{brief.mayExplore.map((m) => <li key={m.issueId}>{m.text}</li>)}</ul>}
      </BriefSection>

      <BriefSection tone="decision" title="NEEDS DECISION" subtitle="Open choices or contradictions. Ask before designing around these." empty="No open decisions.">
        {brief.needsDecision.length > 0 && <ul>{brief.needsDecision.map((m) => <li key={m.issueId}>{m.text}</li>)}</ul>}
      </BriefSection>

      <section className="dossier-section">
        <h4>What to deliver</h4>
        <ul>{brief.deliverables.map((d, i) => <li key={i}>{d}</li>)}</ul>
        <p className="dossier-fine-print">
          Files: {brief.format.fileTypes.join(' / ')}, at least {brief.format.minimumLongSidePixels}px on the long side. Background: {brief.format.background}. {brief.format.note}
        </p>
      </section>

      <section className="dossier-section">
        <h4>Accepted when</h4>
        <ul>{brief.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul>
      </section>
    </>
  )
}
