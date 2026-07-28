import { Arrow } from "./icons"

interface CTAProps { onLaunch?: () => void }

export default function CTA({ onLaunch }: CTAProps) {
  return (
    <section className="cta" id="start">
      <div className="container">
        <div className="cta__inner reveal">
          <h2 className="cta__title">
            Stop preparing.
            <br />
            Start requesting.
          </h2>
          <p className="cta__sub">
            Make one request, review the suggested work, and create drafts you can actually use.
          </p>
          <button className="btn btn--primary btn--lg cta__btn" onClick={onLaunch}>
            Start a request <Arrow size={17} className="arrow" />
          </button>
        </div>
      </div>
    </section>
  )
}
