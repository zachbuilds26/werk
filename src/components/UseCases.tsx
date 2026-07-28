const cases = [
  {
    req: "I need a proposal for a new website client.",
    chips: ["Proposal", "Project plan", "Scope tracker"],
    team: "Freelance work",
    when: "This week",
  },
  {
    req: "Help me launch my handmade skincare brand.",
    chips: ["Launch plan", "Task list", "Content schedule"],
    team: "Small business",
    when: "Next month",
  },
  {
    req: "Prepare a project kickoff for a new client.",
    chips: ["Meeting plan", "Project brief", "Follow-up tasks"],
    team: "Client work",
    when: "Friday",
  },
]

export default function UseCases() {
  return (
    <section className="section" id="cases">
      <div className="container">
        <div className="section__head section__head--center reveal">
          <span className="eyebrow eyebrow--center">Start with a sentence</span>
          <h2 className="display section__title">Tell WERK what you are trying to do.</h2>
          <p className="lead">A few everyday professional requests, and the useful outputs WERK can suggest.</p>
        </div>
        <div className="cases">
          {cases.map((c) => (
            <article className="case reveal" key={c.req}>
              <p className="case__req">“{c.req}”</p>
              <div className="case__pack">
                {c.chips.map((chip) => <span className="case__chip" key={chip}>{chip}</span>)}
              </div>
              <div className="case__foot"><span>{c.team}</span><i className="case__dot" /><span>{c.when}</span></div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
