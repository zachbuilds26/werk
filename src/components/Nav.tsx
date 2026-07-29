import { useEffect, useState } from "react"
import { Arrow } from "./icons"
import Logo from "./Logo"

type NavView = "landing" | "docs"

interface NavProps {
  view: NavView
  onLaunch?: () => void
  onDocs?: () => void
  onHome?: () => void
}

type NavItem =
  | { kind: "anchor"; href: string; label: string; desc: string }
  | { kind: "action"; label: string; desc: string; onClick: () => void }

export default function Nav({ view, onLaunch, onDocs, onHome }: NavProps) {
  const [open, setOpen] = useState(false)
  const isDocs = view === "docs"

  const goTo = (href: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    setOpen(false)
    const id = href.replace("#", "")
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" })
      history.replaceState(null, "", href)
    }
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  const items: NavItem[] = isDocs
    ? [
        { kind: "action", label: "Back home", desc: "Return to the landing page", onClick: () => { setOpen(false); onHome?.() } },
        { kind: "action", label: "Open workspace", desc: "Start a new package", onClick: () => { setOpen(false); onLaunch?.() } },
      ]
    : [
        { kind: "anchor", href: "#assets", label: "Product", desc: "What Werk makes for you" },
        { kind: "anchor", href: "#how", label: "How it works", desc: "From one request to a full package" },
        { kind: "anchor", href: "#cases", label: "Use cases", desc: "Real requests, real outputs" },
        { kind: "action", label: "Werk docs", desc: "Read the product guide", onClick: () => { setOpen(false); onDocs?.() } },
      ]

  return (
    <div className={`site-head${isDocs ? " site-head--docs" : ""}`}>
      {!isDocs && (
        <div className="topbar" role="region" aria-label="Announcement">
          <div className="topbar__inner">
            <a className="topbar__link" href="#start">
              <span>Review outputs before export</span>
              <span className="topbar__sep" aria-hidden="true" />
              <span className="topbar__cta">
                Open workspace <Arrow size={14} className="topbar__arrow" />
              </span>
            </a>
          </div>
        </div>
      )}

      <header className={`nav${open ? " is-open" : ""}${isDocs ? " nav--docs" : ""}`}>
        <div className="nav__inner">
          <div className="nav__brand-group">
            {isDocs ? (
              <button
                type="button"
                className="brand brand--button"
                aria-label="Back to home"
                onClick={() => { setOpen(false); onHome?.() }}
              >
                <Logo />
              </button>
            ) : (
              <a
                href="#top"
                className="brand"
                aria-label="werk home"
                onClick={() => setOpen(false)}
              >
                <Logo />
              </a>
            )}
            {isDocs && <span className="nav__docs-label">Docs</span>}
          </div>

          <div className="nav__actions">
            <button className="btn btn--primary nav__cta" onClick={onLaunch}>
              Open workspace <Arrow size={15} className="arrow" />
            </button>
            <button
              type="button"
              className="nav__menu-btn"
              aria-expanded={open}
              aria-controls="werk-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((o) => !o)}
            >
              <span className="nav__menu-bars" aria-hidden="true">
                <i />
                <i />
              </span>
            </button>
          </div>
        </div>

        {open && (
          <>
            <button
              type="button"
              className="nav__scrim"
              aria-label="Close menu"
              tabIndex={-1}
              onClick={() => setOpen(false)}
            />
            <div className="nav__panel" id="werk-menu">
              <div className="nav__panel-inner">
                <p className="nav__panel-label">{isDocs ? "Navigate" : "Jump to"}</p>
                <div className="nav__panel-grid">
                  {items.map((item) => (
                    item.kind === "anchor" ? (
                      <a
                        key={item.href}
                        href={item.href}
                        className="nav__panel-item"
                        onClick={goTo(item.href)}
                      >
                        <span className="nav__panel-title">{item.label}</span>
                        <span className="nav__panel-desc">{item.desc}</span>
                        <Arrow size={16} className="nav__panel-arrow" />
                      </a>
                    ) : (
                      <button
                        key={item.label}
                        type="button"
                        className="nav__panel-item"
                        onClick={item.onClick}
                      >
                        <span className="nav__panel-title">{item.label}</span>
                        <span className="nav__panel-desc">{item.desc}</span>
                        <Arrow size={16} className="nav__panel-arrow" />
                      </button>
                    )
                  ))}
                </div>
                <button
                  className="btn btn--primary nav__panel-cta"
                  onClick={() => { setOpen(false); onLaunch?.() }}
                >
                  Open workspace <Arrow size={15} className="arrow" />
                </button>
              </div>
            </div>
          </>
        )}
      </header>
    </div>
  )
}
