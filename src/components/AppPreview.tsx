import { useEffect, useRef, useState } from "react"
import {
  Presentation, Document, Sheet, Calendar, List, Timeline,
  Brief, Check, Arrow, Layers,
} from "./icons"

/**
 * Hero product proof — a WERK workspace rendered in CSS, not a screenshot.
 * Plays a scripted story once the card scrolls into view: type a request ->
 * WERK drafts the board pack -> a macOS cursor clicks "Open the board pack" ->
 * the chat swaps to a board-presentation preview -> the cursor picks a slide ->
 * "Delivered".
 *
 * The whole timeline is CSS (keyframes + delays) gated on one `is-playing`
 * class that an IntersectionObserver adds when the card enters the viewport.
 * Base CSS is a coherent static state (the request, the reply, the chip), so
 * the card reads correctly with no JS and under prefers-reduced-motion.
 */

const ASSETS = [
  { Icon: Presentation, name: "Board presentation" },
  { Icon: Document, name: "Executive summary" },
  { Icon: Sheet, name: "Financial model" },
  { Icon: Calendar, name: "Meeting agenda" },
  { Icon: List, name: "Action items" },
  { Icon: Timeline, name: "Project timeline" },
]

const ACTIONS = [
  { Icon: Brief, label: "Brief" },
  { Icon: Presentation, label: "Deck" },
  { Icon: Sheet, label: "Model" },
]

/** Classic macOS pointing hand — flies in from the lower-right of its target,
 *  dips to "click", then fades. Shown only while the timeline plays. */
function Cursor({ className }: { className?: string }) {
  return (
    <svg className={`apv__cursor${className ? ` ${className}` : ""}`} viewBox="0 0 26 32" aria-hidden="true">
      <path
        d="M6.8 7 C6.8 4 10.2 4 10.2 7 L10.2 12 C10.6 11 12.9 11 12.9 12.6
           C12.9 11.4 15.2 11.4 15.2 13 C15.2 11.9 17.5 12 19.6 12.4
           C21 12.7 20.4 15.2 20.4 17 L20.4 20.5 C20.4 27 16 30.5 11.5 29.8
           C7.5 29.2 5 26 4 22 L2.6 16.8 C2 14.6 3.4 13.4 5 14.2 L6.8 15.2 Z"
        fill="#ffffff"
        stroke="#0e1726"
        strokeWidth="1.9"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M10.3 16.5 L10.3 21 M13 16.5 L13 21 M15.7 16.5 L15.7 21"
        stroke="#0e1726"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function AppPreview() {
  const ref = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!("IntersectionObserver" in window)) {
      setPlaying(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setPlaying(true)
            io.disconnect()
          }
        })
      },
      { threshold: 0.2, rootMargin: "0px 0px -8% 0px" }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div ref={ref} className={`apv${playing ? " is-playing" : ""}`} aria-hidden="true">
      {/* window chrome */}
      <div className="apv__bar">
        <i /><i /><i />
        <span className="apv__title">werk — Board pack</span>
        <span className="apv__pill">6 assets</span>
      </div>

      <div className="apv__body">
        {/* sidebar — the package WERK assembled */}
        <aside className="apv__side">
          <p className="apv__side-label"><Layers size={12} /> Assets</p>
          {ASSETS.map((a, i) => {
            const Icon = a.Icon
            return (
              <div
                className={`apv__side-item${i === 0 ? " is-active" : ""}`}
                key={a.name}
                style={{ animationDelay: `${0.12 + i * 0.06}s` }}
              >
                <Icon size={14} />
                {a.name}
              </div>
            )
          })}
          <div className="apv__side-actions">
            {ACTIONS.map((a) => {
              const Icon = a.Icon
              return (
                <span key={a.label}><Icon size={12} /> {a.label}</span>
              )
            })}
          </div>
        </aside>

        {/* chat — two scenes cross-fade inside a fixed stage */}
        <div className="apv__chat">
          <div className="apv__stage">
            {/* scene 1 — the request, the reply, the chip the cursor clicks */}
            <div className="apv__scene apv__scene-chat">
              <div className="apv__msg apv__msg-user">
                I need a board presentation for next Friday.
              </div>

              <div className="apv__typing"><i /><i /><i /></div>

              <div className="apv__msg apv__msg-ai">
                On it — I&apos;ve drafted your <em>board pack</em>. Six assets, ready to review.
              </div>

              <div className="apv__chip-wrap">
                <span className="apv__chip">
                  <span className="apv__chip-fill" />
                  <Presentation size={13} />
                  <span className="apv__chip-text">Open the board pack</span>
                </span>
                <Cursor />
              </div>
            </div>

            {/* scene 2 — the board-presentation preview; fades in on top of
                scene 1 once the cursor has "clicked" the chip */}
            <div className="apv__scene apv__scene-pack">
              <div className="apv__pack">
                <p className="apv__pack-head"><Presentation size={12} /> Board presentation · 14 slides</p>
                <div className="apv__slide">
                  <span className="apv__slide-eyebrow">Q3 review</span>
                  <span className="apv__slide-title">The whole package,<br />one meeting.</span>
                </div>
                <div className="apv__thumbs">
                  <div className="apv__thumb" />
                  <div className="apv__thumb is-active">
                    <span className="apv__thumb-check"><Check size={11} /></span>
                    <Cursor className="apv__cursor--slide" />
                  </div>
                  <div className="apv__thumb" />
                </div>
                <p className="apv__pack-result"><Check size={12} /> Delivered — board pack ready to share.</p>
              </div>
            </div>
          </div>

          <div className="apv__input">
            <span>Describe what you need…</span>
            <Arrow size={14} />
          </div>
        </div>
      </div>
    </div>
  )
}
