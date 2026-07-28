const steps = [
  {
    num: "01",
    title: "Describe",
    body: "Say what you need in your own words. WERK asks only for the details that change the result.",
    chip: "Plain language",
  },
  {
    num: "02",
    title: "Review",
    body: "WERK suggests a small set of useful outputs. You choose what to create and keep missing details visible.",
    chip: "You stay in control",
  },
  {
    num: "03",
    title: "Deliver",
    body: "Review each draft, request changes, and download the finished files. Your work stays on this browser.",
    chip: "Clear drafts",
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
