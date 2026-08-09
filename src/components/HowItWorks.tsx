const steps = [
  {
    num: "01",
    title: "Send",
    body: "Say what you need in plain language. One prompt is the whole interface—no setup, no interview.",
    chip: "Just send it",
  },
  {
    num: "02",
    title: "Werk writes",
    body: "Werk chooses the outputs that genuinely help, writes them all, and marks the details it could not know.",
    chip: "Complete package",
  },
  {
    num: "03",
    title: "Review & export",
    body: "Read each draft, request changes, fill in the open details, and download. Your work stays in this browser.",
    chip: "Ready to use",
  },
]

export default function HowItWorks() {
  return (
    <section className="section" id="how">
      <div className="container">
        <div className="section__head section__head--center reveal">
          <span className="eyebrow eyebrow--center">How it works</span>
          <h2 className="display section__title">One request. Three steps.</h2>
          <p className="lead">
            Send what you need. Werk writes everything and gives you the finished package.
          </p>
        </div>
        <div className="steps reveal">
          {steps.map((s) => (
            <div className="step" key={s.num}>
              <span className="step__num">{s.num}</span>
              <h3 className="step__title">{s.title}</h3>
              <p className="step__body">{s.body}</p>
              <span className="step__chip">{s.chip}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
