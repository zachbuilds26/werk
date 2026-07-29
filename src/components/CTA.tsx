import { Arrow } from "./icons"

interface CTAProps { onLaunch?: () => void }

export default function CTA({ onLaunch }: CTAProps) {
  return (
    <section className="cta" id="start">
      <div className="container">
        <div className="cta__inner reveal">
          <h2 className="cta__title">
            Open the workspace.
          </h2>
          <p className="cta__sub">
            Make one request, review the package, and export the drafts you need.
          </p>
          <button className="btn btn--primary btn--lg cta__btn" onClick={onLaunch}>
            Open workspace <Arrow size={17} className="arrow" />
          </button>
        </div>
      </div>
    </section>
  )
}
