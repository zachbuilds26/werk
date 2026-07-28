import {
  Presentation,
  Document,
  Sheet,
  Calendar,
  List,
  Timeline,
  Brief,
  Report,
} from "./icons"

const types = [
  { Icon: Presentation, name: "Presentations", desc: "Pitches, updates, and clear slide stories." },
  { Icon: Document, name: "Documents", desc: "Proposals, plans, briefs, and guides." },
  { Icon: Sheet, name: "Spreadsheets", desc: "Trackers, templates, comparisons, and budgets." },
  { Icon: Calendar, name: "Meeting plans", desc: "Useful agendas with the right open questions." },
  { Icon: List, name: "Task lists", desc: "Practical next steps that keep gaps visible." },
  { Icon: Timeline, name: "Schedules", desc: "Sequenced plans with milestones to confirm." },
  { Icon: Brief, name: "Project briefs", desc: "A shared starting point for focused work." },
  { Icon: Report, name: "Summaries", desc: "Clear updates, research notes, and handovers." },
]

export default function Assets() {
  return (
    <section className="section section--alt" id="assets">
      <div className="container">
        <div className="section__head section__head--center reveal">
          <span className="eyebrow eyebrow--center">What Werk can create</span>
          <h2 className="display section__title">The right outputs, not more files.</h2>
          <p className="lead">
            Werk suggests a small set of documents and plans for the outcome you describe. You review the suggestion before it writes.
          </p>
        </div>
        <div className="assets reveal">
          {types.map((t) => {
            const Icon = t.Icon
            return (
              <div className="asset-type" key={t.name}>
                <span className="asset-type__icon"><Icon size={19} /></span>
                <h3 className="asset-type__name">{t.name}</h3>
                <p className="asset-type__desc">{t.desc}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
