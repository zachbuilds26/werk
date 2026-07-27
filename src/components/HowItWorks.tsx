const steps = [
  {
    num: "01",
    title: "Describe",
    body: "Say what you need, as you would to a sharp colleague. WERK reads the intent, the scope, and the deliverables.",
    chip: "Plain language",
  },
  {
    num: "02",
    title: "Coordinate",
    body: "WERK splits the request into the assets the job takes, then makes each one to a professional standard.",
    chip: "Auto-orchestrated",
  },
  {
    num: "03",
    title: "Deliver",
    body: "Review the full package in your workspace. Export, share, or iterate. Everything stays in sync.",
    chip: "Ready to ship",
  },
]

export default function HowItWorks() {
  return (
    <section className="section" id="how">
      <div className="container">
        <div className="section__head section__head--center reveal">
          <span className="eyebrow eyebrow--center">How it works</span>
          <h2 className="display section__title">Three steps. Zero busywork.</h2>
          <p className="lead">
            WERK runs like software, not a chat. Make a request and it returns a finished package.
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
