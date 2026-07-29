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

function viewFromPath(pathname: string): View {
  const path = pathname.replace(/\/+$/, "") || "/"
  if (path === "/docs") return "docs"
  if (path === "/workspace") return "studio"
  return "landing"
}

function pathFromView(view: View): string {
  if (view === "docs") return "/docs"
  if (view === "studio") return "/workspace"
  return "/"
}

export default function App() {
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname))

  useEffect(() => {
    const onPopState = () => setView(viewFromPath(window.location.pathname))
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  useEffect(() => {
    const path = pathFromView(view)
    if (window.location.pathname !== path) history.pushState(null, "", path)
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
  const launch = () => {
    window.scrollTo(0, 0)
    setView("studio")
  }

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
      {view === "landing" && <Footer />}
    </>
  )
}
