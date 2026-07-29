import { useEffect, useState } from "react"
import Nav from "./components/Nav"
import Hero from "./components/Hero"
import HowItWorks from "./components/HowItWorks"
import Assets from "./components/Assets"
import UseCases from "./components/UseCases"
import CTA from "./components/CTA"
import Footer from "./components/Footer"
import Studio from "./components/Studio"
import Docs from "./components/Docs"

type View = "landing" | "docs" | "studio"

export default function App() {
  const [view, setView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem("werk.view")
      return saved === "docs" || saved === "studio" ? saved : "landing"
    } catch {
      return "landing"
    }
  })

  useEffect(() => {
    try { localStorage.setItem("werk.view", view) } catch { /* ignore private mode */ }
  }, [view])

  useEffect(() => {
    if (view === "studio") return
    window.scrollTo(0, 0)
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"))
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("is-in"))
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in")
            io.unobserve(e.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [view])

  const goLanding = () => setView("landing")
  const goDocs = () => setView("docs")
  const launch = () => setView("studio")

  if (view === "studio") {
    return <Studio onBack={goLanding} />
  }

  return (
    <>
      <Nav view={view} onHome={goLanding} onDocs={goDocs} onLaunch={launch} />
      <main>
        {view === "docs" ? (
          <Docs onHome={goLanding} onLaunch={launch} />
        ) : (
          <>
            <Hero onLaunch={launch} />
            <HowItWorks />
            <Assets />
            <UseCases />
            <CTA onLaunch={launch} />
          </>
        )}
      </main>
      <Footer />
    </>
  )
}
