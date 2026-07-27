const cases = [
  {
    req: "Prep the Q4 board pack.",
    chips: ["Board presentation", "Executive summary", "Financial model", "Agenda"],
    team: "Finance",
    when: "Friday",
  },
  {
    req: "Launch the new feature next week.",
    chips: ["Launch plan", "Release notes", "Announcement", "Timeline", "Action items"],
    team: "Product",
    when: "7 days",
  },
  {
    req: "Run the partnership kickoff.",
    chips: ["Agenda", "Brief", "Action items", "Follow-up summary"],
    team: "Partnerships",
    when: "Today",
  },
]

export default function UseCases() {
  return (
    <section className="section" id="cases">
      <div className="container">
        <div className="section__head section__head--center reveal">
          <span className="eyebrow eyebrow--center">Start with a sentence</span>
          <h2 className="display section__title">One ask, one pack.</h2>
          <p className="lead">A few real requests, and the package WERK assembles for each.</p>
        </div>
        <div className="cases">
          {cases.map((c) => (
            <article className="case reveal" key={c.req}>
              <p className="case__req">“{c.req}”</p>
              <div className="case__pack">
                {c.chips.map((chip) => (
                  <span className="case__chip" key={chip}>
                    {chip}
                  </span>
                ))}
              </div>
              <div className="case__foot">
                <span>{c.team}</span>
                <i className="case__dot" />
                <span>{c.when}</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
