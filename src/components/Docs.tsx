import { useEffect, useState } from "react"

interface DocsProps {
  onLaunch?: () => void
  onHome?: () => void
}

const tocItems = [
  { id: "overview", label: "Overview" },
  { id: "workflow", label: "How it works" },
  { id: "workspace", label: "Workspace" },
  { id: "outputs", label: "Outputs" },
  { id: "review", label: "Review" },
  { id: "export", label: "Export" },
  { id: "browser-data", label: "Browser-local data" },
  { id: "faq", label: "FAQ" },
  { id: "related", label: "Related" },
]

const outputKinds = [
  "Presentations",
  "Documents",
  "Spreadsheets",
  "Meeting plans",
  "Task lists",
  "Schedules",
  "Project briefs",
  "Summaries",
]

const faqItems = [
  {
    question: "Can I share this page?",
    answer: "Yes. /docs is a direct route, so you can share it without sending people through the landing page.",
  },
  {
    question: "Can I open the workspace from here?",
    answer: "Yes. Use the header action or the related link at the end of the page to go straight to /workspace.",
  },
  {
    question: "Does the video stay on the site?",
    answer: "Yes. The video is embedded in the page, so visitors do not leave Werk to watch it.",
  },
]

export default function Docs({ onLaunch, onHome }: DocsProps) {
  const [activeId, setActiveId] = useState("overview")

  useEffect(() => {
    const targets = tocItems
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => Boolean(el))

    if (!("IntersectionObserver" in window) || targets.length === 0) return

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting)
        if (!visible.length) return
        visible.sort((a, b) => b.intersectionRatio - a.intersectionRatio)
        setActiveId((visible[0].target as HTMLElement).id)
      },
      { rootMargin: "-22% 0px -62% 0px", threshold: [0.08, 0.16, 0.32, 0.5, 0.72] },
    )

    targets.forEach((target) => io.observe(target))
    return () => io.disconnect()
  }, [])

  return (
    <section className="section docs-shell" id="top">
      <div className="container docs-shell__grid">
        <aside className="docs-shell__toc" aria-label="On this page">
          <p className="docs-shell__toc-label">On this page</p>
          <nav aria-label="Document sections">
            <ul className="docs-shell__toc-list">
              {tocItems.map((item) => (
                <li key={item.id}>
                  <a
                    className="docs-shell__toc-link"
                    href={`#${item.id}`}
                    aria-current={activeId === item.id ? "true" : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <article className="docs-shell__article">
          <header className="docs-shell__header">
            <span className="eyebrow">Werk docs</span>
            <h1 className="display docs-shell__title">A detailed guide to Werk.</h1>
            <p className="lead docs-shell__lead">
              Werk turns one request into a reviewed package of business assets. It asks for the details that matter, shows the drafts, and lets you export the files you need.
            </p>
            <div className="docs-shell__callout">
              <p>
                If you want to try it now, open <button type="button" className="docs-shell__inline-link" onClick={onLaunch}>/workspace</button>.
                The sections below explain the request flow, review loop, export formats, and local storage model.
              </p>
            </div>
          </header>

          <figure className="docs-shell__video">
            <div className="docs-shell__frame">
              <iframe
                title="Werk overview video"
                src="https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?rel=0"
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
            <figcaption className="docs-shell__caption">Product overview video.</figcaption>
          </figure>

          <section className="docs-shell__section" id="overview">
            <h2 className="docs-shell__section-title">Overview</h2>
            <p>
              Werk is a workspace for one request and the package that follows from it. It starts with the intent, keeps the gaps visible, and returns a reviewed set of files instead of a blank chat transcript.
            </p>
            <p>
              The page is built for professional work: proposals, board packs, project briefs, schedules, and other documents that need to be read, revised, and exported.
            </p>
          </section>

          <section className="docs-shell__section" id="workflow">
            <h2 className="docs-shell__section-title">How it works</h2>
            <ol className="docs-shell__steps">
              <li>
                <strong>Describe.</strong> Write what you need in plain language. Werk asks only for the details that change the result.
              </li>
              <li>
                <strong>Review.</strong> Werk proposes the package shape first, then shows each draft so you can check the content before export.
              </li>
              <li>
                <strong>Export.</strong> Download the files you need once the package is ready, or revise one draft without rebuilding the whole set.
              </li>
            </ol>
            <div className="docs-shell__note">
              The flow stays in one browser session on this device, so a refresh brings you back to the same local workspace.
            </div>
          </section>

          <section className="docs-shell__section" id="workspace">
            <h2 className="docs-shell__section-title">Workspace</h2>
            <p>
              The workspace is where the request, package plan, and drafts live. Use it when you want Werk to organize the output, ask for a missing detail, and keep the package readable as it changes.
            </p>
            <ul className="docs-shell__list">
              <li>One request starts the package.</li>
              <li>Clarifying questions appear only when a missing detail changes the result.</li>
              <li>Each asset can be revised on its own.</li>
            </ul>
          </section>

          <section className="docs-shell__section" id="outputs">
            <h2 className="docs-shell__section-title">Outputs</h2>
            <p>
              Werk returns the right mix of outputs for the request. Typical asset kinds include:
            </p>
            <ul className="docs-shell__list docs-shell__list--columns">
              {outputKinds.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              The package is meant to be reviewed, not skimmed. The structure stays clear enough to edit before export.
            </p>
          </section>

          <section className="docs-shell__section" id="review">
            <h2 className="docs-shell__section-title">Review</h2>
            <p>
              Each draft is checked before export. Missing context stays visible so the package stays honest about what is known and what still needs confirmation.
            </p>
            <div className="docs-shell__note">
              Werk is built to show the gaps, not hide them.
            </div>
            <ul className="docs-shell__list">
              <li>Compare the draft with the original request.</li>
              <li>Open one asset at a time when you need a closer read.</li>
              <li>Revise the specific output that needs work.</li>
            </ul>
          </section>

          <section className="docs-shell__section" id="export">
            <h2 className="docs-shell__section-title">Export</h2>
            <p>
              Download Markdown for the text version, or use the native file format for the asset you are looking at. The supported outputs include PDF, PPTX, and XLSX depending on the draft.
            </p>
            <p>
              Export happens after the draft is visible, so you keep the final review step close to the file you are about to save.
            </p>
          </section>

          <section className="docs-shell__section" id="browser-data">
            <h2 className="docs-shell__section-title">Browser-local data</h2>
            <p>
              The workspace state lives in the browser on this device. That keeps the app light and fast without adding a paid storage layer.
            </p>
            <ul className="docs-shell__list">
              <li>Refreshes restore the local workspace.</li>
              <li>Clearing browser data clears saved versions.</li>
              <li>The data does not sync across devices.</li>
            </ul>
            <p>
              That tradeoff is deliberate. It keeps the product simple and private, but the workspace stays local to one browser profile.
            </p>
          </section>

          <section className="docs-shell__section" id="faq">
            <h2 className="docs-shell__section-title">FAQ</h2>
            <dl className="docs-shell__faq">
              {faqItems.map((item) => (
                <div className="docs-shell__qa" key={item.question}>
                  <dt>{item.question}</dt>
                  <dd>{item.answer}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="docs-shell__section docs-shell__section--end" id="related">
            <h2 className="docs-shell__section-title">Related resources</h2>
            <ul className="docs-shell__related">
              <li>
                <button type="button" className="docs-shell__related-link" onClick={onLaunch}>
                  Open /workspace
                </button>
              </li>
              <li>
                <button type="button" className="docs-shell__related-link" onClick={onHome}>
                  Back home
                </button>
              </li>
            </ul>
          </section>
        </article>
      </div>
    </section>
  )
}
