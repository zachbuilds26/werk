import { useEffect, useRef, useState } from "react"
import { Arrow, Check, Download, Redo } from "./icons"
import Logo from "./Logo"
import {
  streamGenerate, buildConversationRequest,
  downloadAsset, downloadPackage, regenerateAsset, KIND_META,
  type PackagePlan, type PlanAsset, type AssetDraft,
  type GenerateEvent, type RenderFormat,
} from "../lib/api"

type Phase = "empty" | "working" | "ready" | "error"

interface DraftState {
  draft?: AssetDraft
  versions?: AssetDraft[]
  error?: string
  warning?: string
  status?: "queued" | "drafting" | "verifying" | "revising"
  done: boolean
}

interface ChatTurn {
  request: string
  plan: PackagePlan | null
  drafts: Record<string, DraftState>
  openInputs?: string[]
  errorMsg: string
}

interface StudioProps { onBack: () => void }

// localStorage key for the persisted session (the package survives a refresh).
const STORAGE_KEY = "werk.session.v1"

const EXAMPLES = [
  "Create a client proposal for my website design service.",
  "Plan the launch of my handmade skincare brand.",
  "Prepare a project kickoff for a new client.",
  "Make a job-search plan for a product manager role.",
]

function restoreTurn(turn: ChatTurn): ChatTurn {
  if (!turn.plan?.assets?.length) return turn
  const drafts: Record<string, DraftState> = {}
  for (const asset of turn.plan.assets) {
    const saved = turn.drafts?.[asset.id]
    drafts[asset.id] = saved?.done
      ? saved
      : { done: true, error: "Interrupted — regenerate to finish." }
  }
  return { ...turn, drafts }
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

type PackageSnapshot = {
  total: number
  completed: number
  active: number
  failed: number
  warnings: number
  versionCount: number
  openInputs: string[]
  knownDetails: string[]
}

function getPackageSnapshot(plan: PackagePlan | null, drafts: Record<string, DraftState>): PackageSnapshot {
  if (!plan) {
    return { total: 0, completed: 0, active: 0, failed: 0, warnings: 0, versionCount: 0, openInputs: [], knownDetails: [] }
  }

  const openInputs = [...new Set([
    ...plan.brief.openInputs,
    ...plan.assets.flatMap((asset) => drafts[asset.id]?.draft?.metadata?.gaps ?? []),
  ])]
  let completed = 0
  let active = 0
  let failed = 0
  let warnings = 0
  let versionCount = 0

  for (const asset of plan.assets) {
    const state = drafts[asset.id]
    if (state?.draft) completed += 1
    if (state?.status === "drafting" || state?.status === "verifying" || state?.status === "revising") active += 1
    if (state?.error) failed += 1
    if (state?.warning) warnings += 1
    versionCount += state?.versions?.length ?? (state?.draft ? 1 : 0)
  }

  return { total: plan.assets.length, completed, active, failed, warnings, versionCount, openInputs, knownDetails: plan.brief.knownDetails }
}

function getPackageStatusLabel(phase: Phase, snapshot: PackageSnapshot): string {
  if (phase === "error") return "Something went wrong"
  if (phase === "empty") return "Ready when you are"
  if (phase === "working") return snapshot.total ? `Writing ${snapshot.completed} of ${snapshot.total}` : "Planning your outputs"
  if (snapshot.failed > 0) return `${snapshot.failed} to retry`
  return `Done · ${snapshot.completed} of ${snapshot.total}`
}

function getPackageStatusTone(phase: Phase, snapshot: PackageSnapshot): "idle" | "busy" | "ready" | "danger" {
  if (phase === "error" || snapshot.failed > 0) return "danger"
  if (phase === "working") return "busy"
  if (phase === "ready" && snapshot.completed > 0) return "ready"
  return "idle"
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1)
}

export default function Studio({ onBack }: StudioProps) {
  const [phase, setPhase] = useState<Phase>("empty")
  const [history, setHistory] = useState<ChatTurn[]>([])
  const [request, setRequest] = useState("")
  const [plan, setPlan] = useState<PackagePlan | null>(null)
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState("")
  const [openInputs, setOpenInputs] = useState<string[]>([])
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null)
  const [downloadingPkg, setDownloadingPkg] = useState(false)
  const [downloadPkgError, setDownloadPkgError] = useState("")
  const abortRef = useRef<AbortController | null>(null)
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null)
  // Whether the reader is parked at the bottom. New output follows them only
  // when they are; otherwise reading an earlier draft would be yanked away.
  const nearBottomRef = useRef(true)
  // the request actually sent to generation. Kept in a ref so a single-asset
  // regenerate reuses the same context instead of rerunning the whole package.
  const genRequestRef = useRef("")

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    const onScroll = () => {
      const gap = document.documentElement.scrollHeight - window.innerHeight - window.scrollY
      nearBottomRef.current = gap < 160
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  /* ---- persistence: restore the active conversation on refresh ---- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const s = JSON.parse(raw) as {
        history?: ChatTurn[]; request?: string; plan?: PackagePlan | null;
        drafts?: Record<string, DraftState>; openInputs?: string[]; genRequest?: string;
        phase?: Phase;
      }
      if (!s.request && !s.plan && !s.history?.length) return
      const active = restoreTurn({
        request: s.request || "",
        plan: s.plan ?? null,
        drafts: s.drafts ?? {},
        openInputs: s.openInputs ?? [],
        errorMsg: "",
      })
      genRequestRef.current = s.genRequest || active.request
      setHistory(Array.isArray(s.history) ? s.history.map(restoreTurn) : [])
      setRequest(active.request)
      setPlan(active.plan)
      setDrafts(active.drafts)
      setOpenInputs(active.openInputs ?? [])
      setPhase(active.plan ? "ready" : "empty")
    } catch { /* ignore corrupt storage */ }
  }, [])

  // Persist stable turns only. A refresh during generation is deliberately not
  // saved, so it cannot restore a partially-built follow-up as complete.
  useEffect(() => {
    if (phase === "working") return
    const snap = {
      history, request, plan, drafts, openInputs,
      genRequest: genRequestRef.current,
      phase: phase === "ready" ? phase : undefined,
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)) } catch { /* ignore quota */ }
  }, [history, request, plan, drafts, openInputs, phase])

  useEffect(() => {
    if (!nearBottomRef.current) return
    window.scrollTo({ top: document.documentElement.scrollHeight })
  }, [history, request, plan, drafts, phase])

  const openDrawer = (id: string) => {
    drawerReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpenId(id)
  }

  // One prompt is the whole interface. No profile to fill in, no questions to
  // answer, no plan to approve: this sends the request and the work starts.
  const start = (text: string) => {
    const value = text.trim()
    if (!value) return
    const currentTurn: ChatTurn | null = request
      ? { request, plan, drafts, openInputs, errorMsg }
      : null
    const contextTurns = [...history, ...(currentTurn ? [currentTurn] : [])].map((turn) => ({
      request: turn.request, reply: turn.plan?.reply, packageTitle: turn.plan?.packageTitle, assets: turn.plan?.assets,
      knownDetails: turn.plan?.brief.knownDetails, openInputs: turn.openInputs,
    }))
    const contextualRequest = buildConversationRequest(contextTurns, value)
    abortRef.current?.abort(); const ctrl = new AbortController(); abortRef.current = ctrl
    genRequestRef.current = contextualRequest
    if (currentTurn) setHistory((turns) => [...turns, currentTurn])
    setRequest(value); setPlan(null); setDrafts({}); setOpenId(null); setErrorMsg(""); setDownloadPkgError(""); setOpenInputs([]); setPhase("working")
    nearBottomRef.current = true

    streamGenerate(contextualRequest, [], (e: GenerateEvent) => {
      if (e.type === "plan") {
        setPlan(e.plan)
        setOpenInputs(e.plan.brief.openInputs)
        // Every row is created here, at full height, before any of them has
        // content. Later events only change the glyph inside a row, so the page
        // never grows under the reader while the work runs.
        setDrafts(Object.fromEntries(e.plan.assets.map((a) => [a.id, { done: false, status: "queued" as const }])))
      }
      else if (e.type === "asset-status") setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], status: e.status, done: false } }))
      else if (e.type === "quality-warning") setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], warning: e.issues.map((issue) => issue.message).join(" ") } }))
      else if (e.type === "draft") setDrafts((d) => { const previous = d[e.id]; const versions = [...(previous?.versions ?? (previous?.draft ? [previous.draft] : [])), e.draft]; return { ...d, [e.id]: { draft: e.draft, versions, done: true } } })
      else if (e.type === "draft-error") setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], error: e.message, done: true } }))
      else if (e.type === "done") setPhase("ready")
      else if (e.type === "error") { setErrorMsg(e.message); setPhase("error") }
    }, ctrl.signal).catch((err) => { if (err?.name !== "AbortError") { setErrorMsg(err?.message ?? "Request failed"); setPhase("error") } })
  }

  const reset = () => {
    abortRef.current?.abort()
    setPhase("empty")
    setHistory([])
    setRequest("")
    setPlan(null)
    setDrafts({})
    setOpenId(null)
    setErrorMsg("")
    setDownloadPkgError("")
    setOpenInputs([])
    setRegeneratingId(null)
    genRequestRef.current = ""
  }

  // regenerate a single asset in place, reusing the same request context the
  // package was built from (so the new draft still tracks the original ask).
  const regenerate = (id: string, instruction?: string) => {
    const asset = plan?.assets.find((a) => a.id === id)
    if (!asset || !plan || regeneratingId) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRegeneratingId(id)
    setDrafts((d) => ({ ...d, [id]: { ...d[id], status: "revising", done: false, error: undefined } }))
    regenerateAsset(asset, genRequestRef.current, plan.brief, openInputs, drafts[id]?.draft, instruction, ctrl.signal)
      .then((draft) => {
        setDrafts((d) => {
          const previous = d[id]
          const versions = [...(previous?.versions ?? (previous?.draft ? [previous.draft] : [])), draft]
          return { ...d, [id]: { draft, versions, done: true } }
        })
      })
      .catch((err) => {
        if (err?.name !== "AbortError") {
          setDrafts((d) => ({
            ...d,
            [id]: { ...d[id], error: err?.message ?? "Regenerate failed", done: true },
          }))
        }
      })
      .finally(() => setRegeneratingId(null))
  }

  // the finished assets, paired with their native download format — what the
  // "Download all" zip contains.
  const snapshot = getPackageSnapshot(plan, drafts)
  const doneItems = plan?.assets
    .filter((a) => drafts[a.id]?.draft)
    .map((a) => ({ draft: drafts[a.id]!.draft!, format: KIND_META[a.kind].format })) ?? []
  const canDownloadPkg = doneItems.length > 0 && phase !== "working"

  const downloadPkg = async () => {
    if (!plan || doneItems.length === 0 || downloadingPkg) return
    setDownloadPkgError("")
    setDownloadingPkg(true)
    try {
      await downloadPackage(plan.packageName, doneItems)
    } catch (error) {
      setDownloadPkgError(error instanceof Error ? error.message : "Package download failed")
    } finally {
      setDownloadingPkg(false)
    }
  }

  const activeAsset = openId ? plan?.assets.find((a) => a.id === openId) ?? null : null
  const packageStatusLabel = getPackageStatusLabel(phase, snapshot)
  const packageStatusTone = getPackageStatusTone(phase, snapshot)

  return (
    <div className="cx-page">
      {/* A real page header, not a fake window titlebar. Fixed height, and the
          status sits in a fixed-width slot so its text changing length cannot
          nudge the brand or the buttons. */}
      <header className="cx-top">
        <div className="cx-top__inner">
          <span className="cx-top__brand"><Logo /></span>
          <span className={`cx-top__status cx__pill cx__pill--${packageStatusTone}`}>
            <span className="cx__pill-dot" /> {packageStatusLabel}
          </span>
          <div className="cx-top__actions">
            <button className="cx-top__act" onClick={downloadPkg} disabled={!canDownloadPkg || downloadingPkg} hidden={!canDownloadPkg}>
              <Download size={15} />
              {downloadingPkg ? "Zipping…" : "Download all"}
            </button>
            <button className="cx-top__act" onClick={reset} hidden={phase === "empty"}>New chat</button>
            <button className="cx-top__act" onClick={onBack}>Exit</button>
          </div>
        </div>
      </header>

      <main className="cx-main">
        {phase === "empty" ? (
          <Empty onStart={start} />
        ) : (
          <Thread
            history={history}
            request={request}
            plan={plan}
            drafts={drafts}
            phase={phase}
            errorMsg={errorMsg}
            onOpen={openDrawer}
            onSend={start}
            onDownloadPkg={downloadPkg}
            downloadingPkg={downloadingPkg}
            canDownloadPkg={canDownloadPkg}
            downloadPkgError={downloadPkgError}
          />
        )}
      </main>

      <Drawer
        asset={activeAsset}
        state={activeAsset ? drafts[activeAsset.id] : undefined}
        regenerating={!!activeAsset && regeneratingId === activeAsset.id}
        onRegenerate={regenerate}
        onClose={() => setOpenId(null)}
        restoreFocusRef={drawerReturnFocusRef}
      />
    </div>
  )
}

/* ---- empty state: greeting + composer, straight on the page ---- */
function Empty({ onStart }: { onStart: (text: string) => void }) {
  return (
    <div className="cx__empty">
      <h1 className="cx__greeting">What do you need?</h1>
      <p className="cx__greeting-sub">
        Say it in one sentence. Werk works out which documents help, writes them, and hands you the files.
      </p>
      <Composer onSend={onStart} large autoFocus />
      <div className="cx__examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} className="cx__example" onClick={() => onStart(ex)}>{ex}</button>
        ))}
      </div>
    </div>
  )
}

/* ---- what Werk could not know, kept visible instead of invented ---- */
function PackageNotes({ snapshot }: { snapshot: PackageSnapshot }) {
  if (!snapshot.openInputs.length) return null
  return (
    <section className="cx__trust">
      <p className="cx__trust-kicker">Details to confirm</p>
      <div className="cx__trust-list cx__trust-list--open">
        {snapshot.openInputs.slice(0, 6).map((detail) => <span key={detail}>{detail}</span>)}
      </div>
      <p className="cx__trust-copy">
        Werk marked these in the files rather than making them up. Tell it the real details in your next message and it will rewrite with them.
      </p>
    </section>
  )
}

/* ---- the conversation thread ---- */
function Thread({
  history, request, plan, drafts, phase, errorMsg,
  onOpen, onSend, onDownloadPkg, downloadingPkg, canDownloadPkg, downloadPkgError,
}: {
  history: ChatTurn[]
  request: string
  plan: PackagePlan | null
  drafts: Record<string, DraftState>
  phase: Phase
  errorMsg: string
  onOpen: (id: string) => void
  onSend: (text: string) => void
  onDownloadPkg: () => void
  downloadingPkg: boolean
  canDownloadPkg: boolean
  downloadPkgError: string
}) {
  const total = plan?.assets.length ?? 0
  const doneCount = plan?.assets.filter((asset) => drafts[asset.id]?.done).length ?? 0
  const snapshot = getPackageSnapshot(plan, drafts)

  return (
    <>
      <div className="cx__thread">
        <div className="cx__thread-inner">
          {history.map((turn, index) => <ArchivedTurn key={`${index}-${turn.request}`} turn={turn} />)}

          {/* current user message */}
          <div className="cx__msg cx__msg--user">
            <div className="cx__bubble">{request}</div>
          </div>

          {/* assistant message */}
          <div className="cx__msg cx__msg--ai">
            <span className="cx__avatar" aria-hidden="true">
              <img src="/werk-mark.png" alt="" />
            </span>
            <div className="cx__ai-body">
              {/* One slot for the reply line. It holds the live status first and
                  the plan's own words after, so the block never changes height
                  and nothing below it jumps. */}
              <p className="cx__reply cx__reply--slot" role="status" aria-live="polite">
                {plan
                  ? (phase === "working" ? `Writing ${doneCount} of ${total} outputs…` : plan.reply)
                  : "Working out which outputs will help…"}
              </p>

              {plan && (
                <>
                  <PackageNotes snapshot={snapshot} />
                  {/* Every row exists from the moment the plan lands. Only the
                      glyph inside a row changes as each output finishes. */}
                  <div className="cx__pack">
                    <div className="cx__pack-head">
                      <span className="cx__pack-name">{plan.packageName}</span>
                      <span className="cx__pack-count">{doneCount} / {total}</span>
                    </div>
                    <div className="cx__cards">
                      {plan.assets.map((a) => (
                        <AssetRow key={a.id} asset={a} state={drafts[a.id]} onOpen={() => onOpen(a.id)} />
                      ))}
                    </div>
                  </div>
                  <div className="cx__chip-wrap">
                    <button className="cx__chip" onClick={() => onOpen(plan.assets[0].id)} disabled={!drafts[plan.assets[0].id]?.draft}>
                      <AssetIcon kind={plan.assets[0].kind} size={13} />
                      <span className="cx__chip-text">Open the {plan.packageName.toLowerCase()}</span>
                      <Arrow size={13} className="arrow" />
                    </button>
                    <button className="cx__chip cx__chip--pkg" onClick={onDownloadPkg} disabled={!canDownloadPkg || downloadingPkg}>
                      <Download size={13} />
                      <span className="cx__chip-text">{downloadingPkg ? "Zipping…" : "Download all"}</span>
                    </button>
                  </div>
                  {downloadPkgError && <p className="cx__quality-note" role="alert">{downloadPkgError}</p>}
                </>
              )}

              {phase === "error" && (
                <p className="cx__reply cx__reply--error" role="alert">{errorMsg || "Something went wrong."}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The composer never swaps out for anything: you can always type the
          next request, including while the current one is still running. */}
      <div className="cx__composer-dock">
        <div className="cx__composer-wrap">
          <Composer onSend={onSend} placeholder="Ask for something else…" disabled={phase === "working"} />
        </div>
      </div>
    </>
  )
}

/* ---- a completed earlier turn in the active conversation ---- */
function ArchivedTurn({ turn }: { turn: ChatTurn }) {
  return (
    <>
      <div className="cx__msg cx__msg--user">
        <div className="cx__bubble">{turn.request}</div>
      </div>
      <div className="cx__msg cx__msg--ai">
        <span className="cx__avatar" aria-hidden="true">
          <img src="/werk-mark.png" alt="" />
        </span>
        <div className="cx__ai-body">
          {turn.plan && (
            <>
              <p className="cx__reply">{turn.plan.reply}</p>
              {turn.plan.assets.length > 0 && (
                <div className="cx__pack">
                  <div className="cx__pack-head">
                    <span className="cx__pack-name">{turn.plan.packageName}</span>
                    <span className="cx__pack-count">{turn.plan.assets.length} assets</span>
                  </div>
                  <div className="cx__cards">
                    {turn.plan.assets.map((asset) => (
                      <div key={asset.id} className="cx__card">
                        <span className="cx__card-icon"><AssetIcon kind={asset.kind} size={18} /></span>
                        <span className="cx__card-text">
                          <span className="cx__card-name">{asset.title}</span>
                          <span className="cx__card-meta">{KIND_META[asset.kind].formatLabel} · {asset.summary}</span>
                        </span>
                        <span className="cx__card-status">
                          {turn.drafts[asset.id]?.error ? <span className="cx__x">!</span> : <span className="cx__done"><Check size={13} /></span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {turn.errorMsg && <p className="cx__reply cx__reply--error">{turn.errorMsg}</p>}
        </div>
      </div>
    </>
  )
}

/* ---- one output row in the thread ---- */
function AssetRow({ asset, state, onOpen }: { asset: PlanAsset; state?: DraftState; onOpen: () => void }) {
  const meta = KIND_META[asset.kind]
  const building = !state?.done
  const failed = !!state?.error
  return (
    <button className={`cx__card${building ? " is-building" : ""}`} onClick={onOpen} disabled={building}>
      <span className="cx__card-icon"><AssetIcon kind={asset.kind} size={18} /></span>
      <span className="cx__card-text">
        <span className="cx__card-name">{asset.title}</span>
        <span className="cx__card-meta">{meta.formatLabel} · {asset.summary}</span>
      </span>
      <span className="cx__card-status">
        {failed ? <span className="cx__x">!</span>
          : building ? <span className="cx__spin" />
          : <span className="cx__done"><Check size={13} /></span>}
      </span>
    </button>
  )
}

/* ---- composer (shared by empty state + thread dock) ---- */
function Composer({
  onSend, placeholder = "Describe what you need…", large, autoFocus, disabled,
}: {
  onSend: (text: string) => void
  placeholder?: string
  large?: boolean
  autoFocus?: boolean
  disabled?: boolean
}) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])

  // auto-grow the textarea up to a cap
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 200) + "px"
  }, [text])

  const submit = () => {
    const v = text.trim()
    if (!v || disabled) return
    onSend(v)
    setText("")
  }

  return (
    <div className={`cx__composer${large ? " cx__composer--lg" : ""}`}>
      <textarea
        ref={ref}
        className="cx__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit() }
        }}
        placeholder={placeholder}
        rows={1}
        disabled={disabled}
      />
      <button className="cx__send" onClick={submit} disabled={!text.trim() || disabled} aria-label="Send">
        <Arrow size={18} />
      </button>
    </div>
  )
}

/* ---- slide-in preview drawer ---- */
function Drawer({
  asset, state, regenerating, onRegenerate, onClose, restoreFocusRef,
}: {
  asset: PlanAsset | null
  state?: DraftState
  regenerating: boolean
  onRegenerate: (id: string, instruction?: string) => void
  onClose: () => void
  restoreFocusRef: { current: HTMLElement | null }
}) {
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState("")
  const versions = state?.versions ?? (state?.draft ? [state.draft] : [])
  const [selectedVersion, setSelectedVersion] = useState(0)
  const [revisionInstruction, setRevisionInstruction] = useState("")
  const drawerRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setSelectedVersion(Math.max(0, versions.length - 1))
  }, [asset?.id, versions.length])

  useEffect(() => {
    if (!asset) return
    const root = drawerRef.current
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = "hidden"
    queueMicrotask(() => closeRef.current?.focus())
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== "Tab") return
      const focusable = getFocusableElements(root)
      if (!focusable.length) {
        event.preventDefault()
        closeRef.current?.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
      restoreFocusRef.current?.focus()
      setDownloadError("")
    }
  }, [asset, onClose, restoreFocusRef])

  const draft = versions[selectedVersion] ?? state?.draft
  const hasError = !!state?.error
  const meta = asset ? KIND_META[asset.kind] : null

  const download = async (fmt: RenderFormat) => {
    if (!draft) return
    setDownloading(true)
    setDownloadError("")
    try {
      await downloadAsset(draft, fmt)
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Download failed")
    } finally {
      setDownloading(false)
    }
  }

  const retryRevision = () => {
    if (!asset) return
    onRegenerate(asset.id, revisionInstruction || undefined)
  }

  return (
    <>
      <div className={`cx__scrim${asset ? " is-open" : ""}`} onClick={onClose} />
      <aside
        ref={drawerRef}
        className={`cx__drawer${asset ? " is-open" : ""}`}
        role={asset ? "dialog" : undefined}
        aria-modal={asset ? "true" : undefined}
        aria-labelledby={asset ? `cx-drawer-title-${asset.id}` : undefined}
        aria-describedby={asset ? `cx-drawer-desc-${asset.id}` : undefined}
        aria-hidden={!asset}
      >
        {asset && meta && (
          <>
            <header className="cx__drawer-head">
              <span className="cx__drawer-icon"><AssetIcon kind={asset.kind} size={18} /></span>
              <div className="cx__drawer-titles">
                <h2 className="cx__drawer-name" id={`cx-drawer-title-${asset.id}`}>{draft?.title ?? asset.title}</h2>
                <p className="cx__drawer-blurb" id={`cx-drawer-desc-${asset.id}`}>{draft?.blurb ?? asset.summary}</p>
                {versions.length > 0 && (
                  <label className="cx__drawer-version">
                    <span>Version</span>
                    <select value={selectedVersion} onChange={(e) => setSelectedVersion(Number(e.target.value))}>
                      {versions.map((version, index) => (
                        <option key={`${version.metadata?.revision ?? index + 1}-${index}`} value={index}>
                          v{version.metadata?.revision ?? index + 1}{index === versions.length - 1 ? " · latest" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <button ref={closeRef} className="cx__drawer-close" onClick={onClose} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </header>
            <div className="cx__drawer-body">
              {hasError && (
                <div className="cx__drawer-error" role="alert">
                  <p className="cx__drawer-error-title">
                    {draft ? "A revision needs retry." : "This asset didn’t build."}
                  </p>
                  <p className="cx__drawer-error-msg">{state?.error}</p>
                  <div className="cx__drawer-error-actions">
                    <button className="btn btn--ghost" onClick={retryRevision} disabled={regenerating}>
                      {regenerating ? "Retrying…" : "Try again"}
                    </button>
                  </div>
                </div>
              )}
              {state?.warning && <p className="cx__quality-note" role="status">Quality note: {state.warning}</p>}
              {(draft?.metadata?.gaps.length ?? 0) > 0 && <div className="cx__review-list cx__review-list--open"><strong>Details to confirm</strong>{draft!.metadata!.gaps.map((gap) => <span key={gap}>{gap}</span>)}</div>}
              {draft ? <DraftBody draft={draft} /> : !hasError ? <p className="cx__drawer-empty">No content.</p> : null}
              {downloadError && <p className="cx__quality-note" role="alert">{downloadError}</p>}
            </div>
            <footer className="cx__drawer-foot">
              <div className="cx__drawer-revise">
                <input value={revisionInstruction} onChange={(e) => setRevisionInstruction(e.target.value)} placeholder="What should change?" />
                <button
                  className="btn btn--ghost cx__drawer-regen"
                  disabled={regenerating}
                  onClick={retryRevision}
                  title="Create a revised version using this instruction"
                >
                  <Redo size={15} /> {regenerating ? "Revising…" : "Revise"}
                </button>
              </div>
              <div className="cx__drawer-foot-right">
                <button className="btn btn--ghost" disabled={!draft || downloading} onClick={() => download("md")}>
                  {downloading ? "Downloading…" : "Markdown"}
                </button>
                <button className="btn btn--primary" disabled={!draft || downloading} onClick={() => download(meta.format)}>
                  {downloading ? "Downloading…" : `Download ${meta.formatLabel}`} <Arrow size={15} className="arrow" />
                </button>
              </div>
            </footer>
          </>
        )}
      </aside>
    </>
  )
}

/* ---- draft content renderer ---- */
function DraftBody({ draft }: { draft: AssetDraft }) {
  switch (draft.kind) {
    case "deck": return (
      <div className="cx__draft">
        {(draft.slides ?? []).map((s, i) => (
          <div key={i} className="cx__slide">
            {s.eyebrow && <span className="cx__slide-eyebrow">{s.eyebrow}</span>}
            <p className="cx__slide-title">{s.title}</p>
            <ul>{s.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul>
          </div>
        ))}
      </div>
    )
    case "document": return (
      <div className="cx__draft">
        {(draft.sections ?? []).map((s, i) => (
          <div key={i} className="cx__section">
            <p className="cx__section-h">{s.heading}</p>
            {s.body.map((p, j) => <p key={j} className="cx__section-p">{p}</p>)}
          </div>
        ))}
      </div>
    )
    case "sheet": return draft.table ? (
      <div className="cx__draft cx__draft--table">
        <div className="cx__table-wrap">
          <table className="cx__table">
            <thead><tr>{draft.table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>{draft.table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </div>
    ) : null
    case "agenda": return (
      <div className="cx__draft cx__draft--table">
        <div className="cx__table-wrap">
          <table className="cx__table">
            <thead><tr><th>Time</th><th>Topic</th><th>Owner</th></tr></thead>
            <tbody>{(draft.agenda ?? []).map((a, i) => <tr key={i}><td>{a.time}</td><td>{a.topic}</td><td>{a.owner}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    )
    case "actions": return (
      <div className="cx__draft">
        {(draft.actions ?? []).map((a, i) => (
          <div key={i} className="cx__action">
            <span className="cx__action-dot"><Check size={12} /></span>
            <span className="cx__action-task">{a.task}</span>
            <span className="cx__action-meta">{a.owner} · {a.due}</span>
          </div>
        ))}
      </div>
    )
    case "timeline": return (
      <div className="cx__draft">
        {(draft.timeline ?? []).map((p, i) => (
          <div key={i} className="cx__phase">
            <span className="cx__phase-win">{p.window}</span>
            <div><p className="cx__phase-name">{p.phase}</p><p className="cx__phase-detail">{p.detail}</p></div>
          </div>
        ))}
      </div>
    )
    default: return null
  }
}

function AssetIcon({ kind, size = 20 }: { kind: string; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }
  switch (kind) {
    case "deck": return <svg {...p}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4M8 11v2M12 8.5v4.5M16 11v2" /></svg>
    case "document": return <svg {...p}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 15.5h6M9 8.5h3" /></svg>
    case "sheet": return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="1.5" /><path d="M4 9.5h16M4 14.5h16M10 4v16M15.5 4v16" /></svg>
    case "agenda": return <svg {...p}><rect x="4" y="5" width="16" height="16" rx="1.5" /><path d="M4 9.5h16M8.5 3v4M15.5 3v4" /></svg>
    case "actions": return <svg {...p}><path d="M9 6.5h11M9 12h11M9 17.5h11M4 6.5h.01M4 12h.01M4 17.5h.01" /></svg>
    case "timeline": return <svg {...p}><rect x="3" y="4" width="9" height="3.6" rx="1" /><rect x="7" y="10.2" width="12" height="3.6" rx="1" /><rect x="5" y="16.4" width="8" height="3.6" rx="1" /></svg>
    default: return <svg {...p}><path d="M6 3h8l4 4v14H6z" /></svg>
  }
}
