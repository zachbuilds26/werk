import { useEffect, useState } from "react"
import Nav from "./components/Nav"
import Hero from "./components/Hero"
import HowItWorks from "./components/HowItWorks"
import Assets from "./components/Assets"
import UseCases from "./components/UseCases"
import CTA from "./components/CTA"
import Footer from "./components/Footer"
import Studio from "./components/Studio"

export default function App() {
  // restore the last screen (landing vs studio) so a refresh keeps the user
  // in the workspace with their package rather than bouncing to the top
  const [view, setView] = useState<"landing" | "studio">(() => {
    try {
      return localStorage.getItem("werk.view") === "studio" ? "studio" : "landing"
    } catch {
      return "landing"
    }
  })

  useEffect(() => {
    try { localStorage.setItem("werk.view", view) } catch { /* ignore private mode */ }
  }, [view])

  useEffect(() => {
    if (view !== "landing") return
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

  const launch = () => {
    setView("studio")
    window.scrollTo({ top: 0, behavior: "instant" })
  }

  if (view === "studio") {
    return <Studio onBack={() => setView("landing")} />
  }

  return (
    <>
      <Nav onLaunch={launch} />
      <main>
        <Hero onLaunch={launch} />
        <HowItWorks />
        <Assets />
        <UseCases />
        <CTA onLaunch={launch} />
      </main>
      <Footer />
    </>
  )
}
