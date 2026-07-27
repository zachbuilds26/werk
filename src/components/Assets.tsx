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
  { Icon: Presentation, name: "Presentations", desc: "Board decks and review slides." },
  { Icon: Document, name: "Executive summaries", desc: "One-page summaries that land the point." },
  { Icon: Sheet, name: "Spreadsheets", desc: "Models, plans, and trackers." },
  { Icon: Calendar, name: "Meeting agendas", desc: "Agendas with time and owners." },
  { Icon: List, name: "Action items", desc: "Tasks, owners, and due dates." },
  { Icon: Timeline, name: "Project timelines", desc: "Sequenced plans with milestones." },
  { Icon: Brief, name: "Briefs", desc: "Creative, project, and strategy briefs." },
  { Icon: Report, name: "Reports", desc: "Status, research, and postmortems." },
]

export default function Assets() {
  return (
    <section className="section section--alt" id="assets">
      <div className="container">
        <div className="section__head section__head--center reveal">
          <span className="eyebrow eyebrow--center">What WERK produces</span>
          <h2 className="display section__title">A package, not a single file.</h2>
          <p className="lead">
            Each request resolves into the full set of assets the job requires, made together so
            they agree.
          </p>
        </div>
        <div className="assets reveal">
          {types.map((t) => {
            const Icon = t.Icon
            return (
              <div className="asset-type" key={t.name}>
                <span className="asset-type__icon">
                  <Icon size={19} />
                </span>
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
