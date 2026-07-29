import { Arrow, Document, Layers, Report } from "./icons"
import Assets from "./Assets"
import CTA from "./CTA"
import HowItWorks from "./HowItWorks"

interface DocsProps {
  onLaunch?: () => void
  onHome?: () => void
}

const overviewCards = [
  {
    Icon: Layers,
    kicker: "Overview",
    title: "One request, one stack",
    text: "Start with a plain-language request. WERK turns it into a package of related outputs instead of scattering the work across separate chats.",
  },
  {
    Icon: Document,
    kicker: "Workflow",
    title: "Review before write",
    text: "WERK proposes the package shape first, shows the open inputs, then drafts each asset where you can inspect it.",
  },
  {
    Icon: Report,
    kicker: "Storage",
    title: "Browser-local workspace",
    text: "The browser keeps the workspace state and saved versions on this device so a refresh brings the session back.",
  },
]

const reviewCards = [
  {
    kicker: "Clarify",
    title: "Ask only what matters",
    text: "Short requests can move straight to planning. When a missing detail changes the result, WERK asks a focused question instead of guessing.",
  },
  {
    kicker: "Revise",
    title: "Change one asset",
    text: "Open a draft, add a revision note, and regenerate that asset without rebuilding the whole package.",
  },
  {
    kicker: "Export",
    title: "Download the right format",
    text: "Use Markdown for the text version or the native file format for the asset you are reviewing.",
  },
]

const privacyCards = [
  {
    kicker: "Local state",
    title: "Workspace data stays in the browser",
    text: "The browser stores the workspace context and version history on that device. Clearing browser data clears the local copy.",
  },
  {
    kicker: "No account",
    title: "No sign-in is required",
    text: "WERK does not need a user account or paid storage to remember the workspace on one browser.",
  },
  {
    kicker: "Service scope",
    title: "Generation is request scoped",
    text: "The generation service is used when you ask for a package. The result returns to the browser session, not to a separate document account.",
  },
]

const faqCards = [
  {
    kicker: "FAQ",
    title: "Can I replace the video later?",
    text: "Yes. Swap the temporary YouTube ID for the upload you want to feature and keep the same embed wrapper.",
  },
  {
    kicker: "FAQ",
    title: "Will the video stay on the site?",
    text: "Yes. The embed plays inside the docs page so visitors do not need to leave WERK to watch it.",
  },
  {
    kicker: "FAQ",
    title: "What can I export?",
    text: "Use Markdown for the text version, then export the native format for the asset you are looking at: PDF, PPTX, or XLSX depending on the draft.",
  },
  {
    kicker: "FAQ",
    title: "Does the workspace remember my edits?",
    text: "Yes. The browser keeps the workspace and saved versions on that device until browser data is cleared.",
  },
]

export default function Docs({ onLaunch, onHome }: DocsProps) {
  return (
    <>
      <section className="section docs__intro" id="top">
        <div className="container docs__intro-inner">
          <figure className="docs__video reveal" style={{ transitionDelay: "40ms" }}>
            <div className="docs__frame">
              <iframe
                title="WERK overview video"
                src="https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?rel=0"
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
            <figcaption className="docs__caption">
              This is a temporary placeholder video. Replace the ID with your upload later. Playback stays inside the docs page so visitors do not have to open YouTube.
            </figcaption>
          </figure>

          <div className="docs__hero reveal" style={{ transitionDelay: "100ms" }}>
            <span className="eyebrow eyebrow--center">WERK docs</span>
            <h1 className="display docs__title">A detailed guide to WERK.</h1>
            <p className="lead docs__lead">
              WERK turns one request into a reviewed package of business assets. It asks for the details that matter, shows the drafts, and lets you export the files you need.
            </p>
            <div className="docs__actions">
              <button className="btn btn--primary btn--lg" onClick={onLaunch}>
                Open workspace <Arrow size={17} className="arrow" />
              </button>
              <button className="btn btn--ghost btn--lg" onClick={onHome}>
                Back to home
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="section section--alt docs__section">
        <div className="container">
          <div className="section__head section__head--center reveal">
            <span className="eyebrow eyebrow--center">What WERK is for</span>
            <h2 className="display section__title">A workspace that stays focused on the request.</h2>
            <p className="lead">
              WERK is not a chat transcript. It is a guided workspace that proposes the useful package, keeps gaps visible, and gives you control before export.
            </p>
          </div>
          <div className="docs__grid reveal" style={{ transitionDelay: "60ms" }}>
            {overviewCards.map((card) => {
              const Icon = card.Icon
              return (
                <article className="docs__card" key={card.title}>
                  <span className="docs__card-icon" aria-hidden="true">
                    <Icon size={19} />
                  </span>
                  <span className="docs__card-kicker">{card.kicker}</span>
                  <h3 className="docs__card-title">{card.title}</h3>
                  <p className="docs__card-copy">{card.text}</p>
                </article>
              )
            })}
          </div>
        </div>
      </section>

      <HowItWorks />
      <Assets />

      <section className="section docs__section">
        <div className="container">
          <div className="section__head section__head--center reveal">
            <span className="eyebrow eyebrow--center">Review and export</span>
            <h2 className="display section__title">See the draft before it becomes the file.</h2>
            <p className="lead">
              WERK keeps the package visible while it works. That makes it easier to confirm the shape, revise a single asset, and export the right format.
            </p>
          </div>
          <div className="docs__grid reveal" style={{ transitionDelay: "60ms" }}>
            {reviewCards.map((card) => (
              <article className="docs__card" key={card.title}>
                <span className="docs__card-kicker">{card.kicker}</span>
                <h3 className="docs__card-title">{card.title}</h3>
                <p className="docs__card-copy">{card.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--alt docs__section">
        <div className="container">
          <div className="section__head section__head--center reveal">
            <span className="eyebrow eyebrow--center">Browser-local privacy</span>
            <h2 className="display section__title">Keep the workspace in the browser.</h2>
            <p className="lead">
              WERK is built to stay light. The browser keeps the local workspace while the generation service is used only when you request a package.
            </p>
          </div>
          <div className="docs__grid reveal" style={{ transitionDelay: "60ms" }}>
            {privacyCards.map((card) => (
              <article className="docs__card" key={card.title}>
                <span className="docs__card-kicker">{card.kicker}</span>
                <h3 className="docs__card-title">{card.title}</h3>
                <p className="docs__card-copy">{card.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section docs__section">
        <div className="container">
          <div className="section__head section__head--center reveal">
            <span className="eyebrow eyebrow--center">Questions</span>
            <h2 className="display section__title">The short answers people usually need.</h2>
            <p className="lead">
              If you want the quick version before you try the workspace, start here.
            </p>
          </div>
          <div className="docs__grid docs__grid--two reveal" style={{ transitionDelay: "60ms" }}>
            {faqCards.map((card) => (
              <article className="docs__card" key={card.title}>
                <span className="docs__card-kicker">{card.kicker}</span>
                <h3 className="docs__card-title">{card.title}</h3>
                <p className="docs__card-copy">{card.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <CTA onLaunch={onLaunch} />
    </>
  )
}
