import { useEffect, useRef, useState } from "react"
import { Calendar, Check, Document, Layers, Mark, Presentation, Sheet } from "./icons"

const DELIVERABLES = [
  { Icon: Presentation, title: "Client presentation", meta: "8 slides" },
  { Icon: Document, title: "Project proposal", meta: "4 sections" },
  { Icon: Sheet, title: "Scope tracker", meta: "12 tasks" },
]

/**
 * A deliberately quiet product-film sequence. The visual is real UI rather
 * than a video file: it remains sharp at every size, loads instantly, and is
 * fully disabled for people who prefer reduced motion.
 */
export default function AppPreview() {
  const ref = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || !("IntersectionObserver" in window)) {
      setPlaying(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setPlaying(true)
          observer.disconnect()
        }
      },
      { threshold: 0.18, rootMargin: "0px 0px -7% 0px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className={`apv${playing ? " is-playing" : ""}`} aria-label="Animated Werk product preview">
      <div className="apv__ambient apv__ambient--one" />
      <div className="apv__ambient apv__ambient--two" />
      <div className="apv__window">
        <header className="apv__bar">
          <span className="apv__dots"><i /><i /><i /></span>
          <span className="apv__wordmark">werk</span>
          <span className="apv__bar-title">New client workspace</span>
          <span className="apv__status"><i /> Live</span>
        </header>

        <div className="apv__body">
          <aside className="apv__side">
            <p className="apv__side-label"><Layers size={12} /> Workspace</p>
            <span className="apv__nav-item is-active"><Mark size={14} /> New request</span>
            <span className="apv__nav-item"><Calendar size={14} /> This week</span>
            <div className="apv__side-rule" />
            <p className="apv__side-label">In this package</p>
            {DELIVERABLES.map(({ Icon, title, meta }, index) => (
              <span className="apv__side-file" style={{ animationDelay: `${4.9 + index * 0.13}s` }} key={title}>
                <Icon size={13} /><span>{title}</span><small>{meta}</small>
              </span>
            ))}
          </aside>

          <div className="apv__main">
            <div className="apv__eyebrow"><span /> Request</div>
            <div className="apv__prompt">
              <p>I need a proposal for a new website client.</p>
              <span className="apv__sent"><Check size={11} /> Sent</span>
            </div>

            <div className="apv__response">
              <div className="apv__assistant-mark"><Mark size={14} /></div>
              <div className="apv__response-copy">
                <p>Building a clear, ready-to-review package.</p>
                <div className="apv__scan"><i /><i /><i /></div>
              </div>
            </div>

            <section className="apv__package">
              <div className="apv__package-head">
                <span><Mark size={13} /> Suggested package</span>
                <small>3 items</small>
              </div>
              <div className="apv__cards">
                {DELIVERABLES.map(({ Icon, title, meta }, index) => (
                  <article className="apv__card" style={{ animationDelay: `${3.4 + index * 0.17}s` }} key={title}>
                    <span className="apv__card-icon"><Icon size={15} /></span>
                    <span className="apv__card-copy"><b>{title}</b><small>{meta} prepared</small></span>
                    <span className="apv__card-ready"><Check size={12} /></span>
                  </article>
                ))}
              </div>
              <div className="apv__finish"><Check size={12} /> Ready to refine</div>
            </section>
          </div>
        </div>
      </div>
      <div className="apv__timeline" aria-hidden="true">
        <span className="is-current"><i /> Ask</span><span><i /> Shape</span><span><i /> Ready</span>
        <div><b /></div>
      </div>
    </div>
  )
}
