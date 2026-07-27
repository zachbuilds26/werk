import { Arrow } from "./icons"
import AppPreview from "./AppPreview"

interface HeroProps { onLaunch?: () => void }

export default function Hero({ onLaunch }: HeroProps) {
  return (
    <section className="hero" id="top">
      <div className="container hero__inner">
        <div className="hero__copy">
          <span className="eyebrow eyebrow--center reveal" style={{ transitionDelay: "40ms" }}>
            Professional workspace
          </span>
          <h1 className="display hero__title reveal" style={{ transitionDelay: "90ms" }}>
            One brief.
            <br />
            <em>All assets ready.</em>
          </h1>
          <p className="lead hero__sub reveal" style={{ transitionDelay: "140ms" }}>
            Describe the outcome you need in plain language. WERK coordinates the work and returns
            a complete set of business-ready assets.
          </p>
          <div className="hero__cta reveal" style={{ transitionDelay: "190ms" }}>
            <button className="btn btn--primary btn--lg" onClick={onLaunch}>
              Start a request <Arrow size={17} className="arrow" />
            </button>
            <a className="btn btn--ghost btn--lg" href="#how">
              See how it works
            </a>
          </div>
        </div>

        <div className="hero__demo reveal" style={{ transitionDelay: "240ms" }}>
          <AppPreview />
        </div>
      </div>
    </section>
  )
}
