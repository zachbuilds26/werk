import { useEffect, useState } from "react"
import { Arrow } from "./icons"
import Logo from "./Logo"

interface NavProps { onLaunch?: () => void }

const links = [
  { href: "#assets", label: "Product", desc: "What Werk makes for you" },
  { href: "#how", label: "How it works", desc: "From one request to a full package" },
  { href: "#cases", label: "Use cases", desc: "Real requests, real outputs" },
]

export default function Nav({ onLaunch }: NavProps) {
  const [open, setOpen] = useState(false)

  // Navigate to an in-page section: close the menu, then smooth-scroll to the
  // target. Done explicitly because closing the menu unmounts the clicked
  // anchor, which can cancel the browser's default hash navigation.
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

  // close the menu with Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <div className="site-head">
      <div className="topbar" role="region" aria-label="Announcement">
        <div className="topbar__inner">
          <a className="topbar__link" href="#start">
            <span>Free to try, no card, no account needed</span>
            <span className="topbar__sep" aria-hidden="true" />
            <span className="topbar__cta">
              Start now <Arrow size={14} className="topbar__arrow" />
            </span>
          </a>
        </div>
      </div>

      <header className={`nav${open ? " is-open" : ""}`}>
        <div className="nav__inner">
          <a
            href="#top"
            className="brand"
            aria-label="werk home"
            onClick={() => setOpen(false)}
          >
            <Logo />
          </a>

          <div className="nav__actions">
            <button className="btn btn--primary nav__cta" onClick={onLaunch}>
              Launch app <Arrow size={15} className="arrow" />
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
                <p className="nav__panel-label">Jump to</p>
                <div className="nav__panel-grid">
                  {links.map((l) => (
                    <a
                      key={l.href}
                      href={l.href}
                      className="nav__panel-item"
                      onClick={goTo(l.href)}
                    >
                      <span className="nav__panel-title">{l.label}</span>
                      <span className="nav__panel-desc">{l.desc}</span>
                      <Arrow size={16} className="nav__panel-arrow" />
                    </a>
                  ))}
                </div>
                <button
                  className="btn btn--primary nav__panel-cta"
                  onClick={() => { setOpen(false); onLaunch?.() }}
                >
                  Launch app <Arrow size={15} className="arrow" />
                </button>
              </div>
            </div>
          </>
        )}
      </header>
    </div>
  )
}
