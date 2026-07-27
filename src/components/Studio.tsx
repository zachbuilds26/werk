import { useEffect, useRef, useState } from "react"
import { Arrow, Check, Download, Layers, Redo } from "./icons"
import Logo from "./Logo"
import {
  streamGenerate, clarify as clarifyRequest, buildEnrichedRequest, downloadAsset,
  downloadPackage, regenerateAsset, KIND_META,
  type PackagePlan, type PlanAsset, type AssetDraft,
  type GenerateEvent, type RenderFormat,
  type ClarifyQuestion, type ClarifyResult,
} from "../lib/api"

type Phase = "empty" | "streaming" | "clarifying" | "ready" | "error"

interface DraftState {
  draft?: AssetDraft
  error?: string
  done: boolean
}

interface StudioProps { onBack: () => void }

// localStorage key for the persisted session (the package survives a refresh).
const STORAGE_KEY = "werk.session.v1"

const EXAMPLES = [
  "Prep the Q4 board pack for Friday.",
  "Launch the new billing feature next week.",
  "Run the partnership kickoff meeting.",
  "Report on last quarter's growth experiments.",
]

export default function Studio({ onBack }: StudioProps) {
  const [phase, setPhase] = useState<Phase>("empty")
  const [request, setRequest] = useState("")
  const [plan, setPlan] = useState<PackagePlan | null>(null)
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState("")
  const [clarify, setClarify] = useState<ClarifyResult | null>(null)
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>({})
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null)
  const [downloadingPkg, setDownloadingPkg] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  // the request actually sent to generation (raw, or enriched with clarify
  // answers). Kept in a ref so a single-asset regenerate reuses the same
  // context instead of rerunning the whole package.
  const genRequestRef = useRef("")

  useEffect(() => () => abortRef.current?.abort(), [])

  /* ---- persistence: restore the last package on refresh ---- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const s = JSON.parse(raw) as {
        request?: string; plan?: PackagePlan | null;
        drafts?: Record<string, DraftState>; clarify?: ClarifyResult | null;
        clarifyAnswers?: Record<string, string>; phase?: Phase; genRequest?: string;
      }
      if (!s.plan || !s.plan.assets?.length) return
      // a refresh mid-stream leaves some drafts "building" forever; mark any
      // incomplete asset as interrupted so the user can regenerate it.
      const restoredDrafts: Record<string, DraftState> = {}
      for (const a of s.plan.assets) {
        const d = s.drafts?.[a.id]
        restoredDrafts[a.id] = d && d.done
          ? d
          : { done: true, error: "Interrupted — regenerate to finish." }
      }
      genRequestRef.current = s.genRequest || s.request || ""
      setRequest(s.request || "")
      setPlan(s.plan)
      setDrafts(restoredDrafts)
      setClarify(s.clarify ?? null)
      setClarifyAnswers(s.clarifyAnswers ?? {})
      setPhase("ready")
    } catch { /* ignore corrupt storage */ }
  }, [])

  // persist a snapshot whenever the session settles. Streaming is skipped: a
  // half-built package is only worth restoring once it is stable on reload.
  useEffect(() => {
    if (phase === "streaming") return
    const snap = {
      request, plan, drafts, clarify, clarifyAnswers, phase,
      genRequest: genRequestRef.current,
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)) } catch { /* ignore quota */ }
  }, [request, plan, drafts, clarify, clarifyAnswers, phase])

  // keep the thread pinned to the latest content as drafts stream in
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [plan, drafts, phase, clarify, clarifyAnswers])

  const start = (text: string) => {
    const value = text.trim()
    if (!value) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    genRequestRef.current = value
    // drop any previous package so a refresh mid-stream never resurrects it
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }

    setRequest(value)
    setPlan(null)
    setDrafts({})
    setOpenId(null)
    setErrorMsg("")
    setClarify(null)
    setClarifyAnswers({})
    setPhase("streaming")

    // Decide first whether we have enough context to build well. If not, ask
    // a few targeted questions inline; otherwise go straight to generation.
    clarifyRequest(value, ctrl.signal)
      .then((res) => {
        if (res.mode === "clarify" && res.questions.length > 0) {
          setClarify(res)
          setClarifyAnswers({})
          setPhase("clarifying")
        } else {
          runGenerate(value)
        }
      })
      .catch((err) => {
        if (err?.name !== "AbortError") {
          setErrorMsg(err?.message ?? "Request failed")
          setPhase("error")
        }
      })
  }

  const runGenerate = (req: string) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    genRequestRef.current = req
    setPhase("streaming")

    streamGenerate(req, (e: GenerateEvent) => {
      if (e.type === "plan") {
        setPlan(e.plan)
        setDrafts(Object.fromEntries(e.plan.assets.map((a) => [a.id, { done: false }])))
      } else if (e.type === "draft") {
        setDrafts((d) => ({ ...d, [e.id]: { draft: e.draft, done: true } }))
      } else if (e.type === "draft-error") {
        setDrafts((d) => ({ ...d, [e.id]: { error: e.message, done: true } }))
      } else if (e.type === "done") {
        setPhase("ready")
      } else if (e.type === "error") {
        setErrorMsg(e.message)
        setPhase("error")
      }
    }, ctrl.signal).catch((err) => {
      if (err?.name !== "AbortError") {
        setErrorMsg(err?.message ?? "Request failed")
        setPhase("error")
      }
    })
  }

  const submitClarify = () => {
    if (!clarify) return
    // Keep the card visible (read-only) so the thread records what was given,
    // then fold the answers into a "Context:" block and build the package.
    const enriched = buildEnrichedRequest(request, clarify.questions, clarifyAnswers)
    runGenerate(enriched)
  }

  const onAnswerChange = (key: string, val: string) => {
    setClarifyAnswers((a) => ({ ...a, [key]: val }))
  }

  const reset = () => {
    abortRef.current?.abort()
    setPhase("empty")
    setRequest("")
    setPlan(null)
    setDrafts({})
    setOpenId(null)
    setErrorMsg("")
    setClarify(null)
    setClarifyAnswers({})
    setRegeneratingId(null)
    genRequestRef.current = ""
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }

  // regenerate a single asset in place, reusing the same request context the
  // package was built from (so the new draft still tracks the original ask).
  const regenerate = (id: string) => {
    const asset = plan?.assets.find((a) => a.id === id)
    if (!asset || regeneratingId) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRegeneratingId(id)
    setDrafts((d) => ({ ...d, [id]: { done: false } }))
    regenerateAsset(asset.kind, asset.title, genRequestRef.current, ctrl.signal)
      .then((draft) => {
        setDrafts((d) => ({ ...d, [id]: { draft, done: true } }))
      })
      .catch((err) => {
        if (err?.name !== "AbortError") {
          setDrafts((d) => ({
            ...d,
            [id]: { error: err?.message ?? "Regenerate failed", done: true },
          }))
        }
      })
      .finally(() => setRegeneratingId(null))
  }

  // the finished assets, paired with their native download format — what the
  // "Download package" zip contains.
  const doneItems = plan?.assets
    .filter((a) => drafts[a.id]?.draft)
    .map((a) => ({ draft: drafts[a.id]!.draft!, format: KIND_META[a.kind].format })) ?? []
  const canDownloadPkg = doneItems.length > 0

  const downloadPkg = async () => {
    if (!plan || doneItems.length === 0 || downloadingPkg) return
    setDownloadingPkg(true)
    try { await downloadPackage(plan.packageName, doneItems) }
    catch { /* ignore — the user can retry */ } finally { setDownloadingPkg(false) }
  }

  const openAsset = openId ? plan?.assets.find((a) => a.id === openId) ?? null : null
  const pkgTitle = plan?.packageTitle ?? "New request"
  const assetCount = plan?.assets.length ?? 0

  return (
    <div className="cx-shell">
      <div className="cx">
        {/* window chrome */}
        <div className="cx__bar">
          <span className="cx__bar-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="cx__bar-title">
            <span className="cx__bar-brand"><Logo /></span>
            <span className="cx__bar-sep">—</span>
            <span className="cx__bar-name">{pkgTitle}</span>
          </span>
          {assetCount > 0 && (
            <span className="cx__pill"><span className="cx__pill-dot" /> {assetCount} assets</span>
          )}
        </div>

        <div className="cx__body">
          {/* sidebar — the package WERK assembled (hidden on narrow viewports) */}
          <aside className="cx__side">
            <p className="cx__side-label"><Layers size={12} /> Assets</p>
            <div className="cx__side-list">
              {plan && plan.assets.length > 0 ? (
                plan.assets.map((a) => (
                  <SideItem
                    key={a.id}
                    asset={a}
                    state={drafts[a.id]}
                    active={openId === a.id}
                    onOpen={() => setOpenId(a.id)}
                  />
                ))
              ) : (
                <p className="cx__side-empty">No assets yet</p>
              )}
            </div>
            <div className="cx__side-actions">
              {canDownloadPkg && (
                <button className="cx__side-pkg" onClick={downloadPkg} disabled={downloadingPkg}>
                  <Download size={15} />
                  {downloadingPkg ? "Zipping…" : "Download package"}
                </button>
              )}
              <div className="cx__side-row">
                {phase !== "empty" && (
                  <button className="cx__side-act" onClick={reset}>New chat</button>
                )}
                <button className="cx__side-act" onClick={onBack}>Exit</button>
              </div>
            </div>
          </aside>

          {/* main — chat / empty state / clarify */}
          <main className="cx__main">
            {phase === "empty" ? (
              <Empty onStart={start} />
            ) : (
              <Thread
                threadRef={threadRef}
                request={request}
                plan={plan}
                drafts={drafts}
                phase={phase}
                errorMsg={errorMsg}
                clarify={clarify}
                clarifyAnswers={clarifyAnswers}
                onAnswerChange={onAnswerChange}
                onSubmitClarify={submitClarify}
                onOpen={setOpenId}
                onSend={start}
                onNewChat={reset}
                onDownloadPkg={downloadPkg}
                downloadingPkg={downloadingPkg}
                canDownloadPkg={canDownloadPkg}
              />
            )}
          </main>
        </div>

        <Drawer
          asset={openAsset}
          state={openAsset ? drafts[openAsset.id] : undefined}
          regenerating={!!openAsset && regeneratingId === openAsset.id}
          onRegenerate={regenerate}
          onClose={() => setOpenId(null)}
        />
      </div>
    </div>
  )
}

/* ---- sidebar asset row ---- */
function SideItem({
  asset, state, active, onOpen,
}: {
  asset: PlanAsset
  state?: DraftState
  active: boolean
  onOpen: () => void
}) {
  const building = !state?.done
  const failed = !!state?.error
  return (
    <button className={`cx__side-item${active ? " is-active" : ""}`} onClick={onOpen} disabled={building}>
      <span className="cx__side-icon"><AssetIcon kind={asset.kind} size={14} /></span>
      <span className="cx__side-name">{asset.title}</span>
      <span className="cx__side-status">
        {failed ? <span className="cx__x">!</span>
          : building ? <span className="cx__spin" />
          : <span className="cx__done"><Check size={11} /></span>}
      </span>
    </button>
  )
}

/* ---- empty state: centered greeting + composer ---- */
function Empty({ onStart }: { onStart: (text: string) => void }) {
  return (
    <div className="cx__empty">
      <div className="cx__empty-inner">
        <h1 className="cx__greeting">What do you need?</h1>
        <p className="cx__greeting-sub">
          Describe the outcome in plain language. WERK plans the package and assembles every asset.
        </p>
        <Composer onSend={onStart} large autoFocus />
        <div className="cx__examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="cx__example" onClick={() => onStart(ex)}>{ex}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ---- the conversation thread (chat pane) ---- */
function Thread({
  threadRef, request, plan, drafts, phase, errorMsg,
  clarify, clarifyAnswers, onAnswerChange, onSubmitClarify, onOpen, onSend, onNewChat,
  onDownloadPkg, downloadingPkg, canDownloadPkg,
}: {
  threadRef: React.RefObject<HTMLDivElement>
  request: string
  plan: PackagePlan | null
  drafts: Record<string, DraftState>
  phase: Phase
  errorMsg: string
  clarify: ClarifyResult | null
  clarifyAnswers: Record<string, string>
  onAnswerChange: (key: string, val: string) => void
  onSubmitClarify: () => void
  onOpen: (id: string) => void
  onSend: (text: string) => void
  onNewChat: () => void
  onDownloadPkg: () => void
  downloadingPkg: boolean
  canDownloadPkg: boolean
}) {
  const doneCount = Object.values(drafts).filter((d) => d.done).length
  const total = plan?.assets.length ?? 0

  return (
    <>
      <div className="cx__thread" ref={threadRef}>
        <div className="cx__thread-inner">
          {/* user message */}
          <div className="cx__msg cx__msg--user">
            <div className="cx__bubble">{request}</div>
          </div>

          {/* assistant message */}
          <div className="cx__msg cx__msg--ai">
            <span className="cx__avatar" aria-hidden="true">
              <img src="/werk-mark.png" alt="" />
            </span>
            <div className="cx__ai-body">
              {!plan && phase === "streaming" && (
                <div className="cx__thinking"><i /><i /><i /></div>
              )}

              {clarify && clarify.reply && !plan && <p className="cx__reply">{clarify.reply}</p>}

              {plan && (
                <>
                  <p className="cx__reply">{plan.reply}</p>
                  {phase === "ready" && plan.assets.length > 0 && (
                    <div className="cx__chip-wrap">
                      <button className="cx__chip" onClick={() => onOpen(plan.assets[0].id)}>
                        <AssetIcon kind={plan.assets[0].kind} size={13} />
                        <span className="cx__chip-text">Open the {plan.packageName.toLowerCase()}</span>
                        <Arrow size={13} className="arrow" />
                      </button>
                      {canDownloadPkg && (
                        <button
                          className="cx__chip cx__chip--pkg"
                          onClick={onDownloadPkg}
                          disabled={downloadingPkg}
                        >
                          <Download size={13} />
                          <span className="cx__chip-text">
                            {downloadingPkg ? "Zipping…" : "Download package"}
                          </span>
                        </button>
                      )}
                    </div>
                  )}
                  {/* inline cards — the narrow-viewport fallback (hidden when
                      the sidebar is shown) */}
                  <div className="cx__pack">
                    <div className="cx__pack-head">
                      <span className="cx__pack-name">{plan.packageName}</span>
                      <span className="cx__pack-count">
                        {phase === "ready" ? `${total} assets` : `${doneCount} / ${total}`}
                      </span>
                    </div>
                    <div className="cx__cards">
                      {plan.assets.map((a) => (
                        <AssetCard key={a.id} asset={a} state={drafts[a.id]} onOpen={() => onOpen(a.id)} />
                      ))}
                    </div>
                  </div>
                </>
              )}

              {phase === "error" && (
                <p className="cx__reply cx__reply--error">{errorMsg || "Something went wrong."}</p>
              )}
            </div>
          </div>

          {clarify && phase === "clarifying" && (
            <div className="cx__clarify">
              {clarify.questions.map((q, i) => (
                <label key={q.key} className="cx__clarify-field">
                  <span className="cx__clarify-q">{q.question}</span>
                  <input
                    className="cx__clarify-input"
                    type="text"
                    placeholder={q.placeholder ?? ""}
                    value={clarifyAnswers[q.key] ?? ""}
                    autoFocus={i === 0}
                    onChange={(e) => onAnswerChange(q.key, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSubmitClarify() } }}
                  />
                </label>
              ))}
              <div className="cx__clarify-foot">
                <button className="btn btn--primary" onClick={onSubmitClarify}>
                  Build the package <Arrow size={15} className="arrow" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="cx__composer-dock">
        <div className="cx__composer-wrap">
          {phase === "ready" ? (
            <button className="cx__new-request" onClick={onNewChat}>
              Start a new request <Arrow size={15} className="arrow" />
            </button>
          ) : (
            <Composer onSend={onSend} placeholder="Make another request…" disabled={phase === "streaming" || phase === "clarifying"} />
          )}
        </div>
      </div>
    </>
  )
}

/* ---- one asset card in the thread (narrow fallback) ---- */
function AssetCard({ asset, state, onOpen }: { asset: PlanAsset; state?: DraftState; onOpen: () => void }) {
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
  asset, state, regenerating, onRegenerate, onClose,
}: {
  asset: PlanAsset | null
  state?: DraftState
  regenerating: boolean
  onRegenerate: (id: string) => void
  onClose: () => void
}) {
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    if (!asset) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [asset, onClose])

  const draft = state?.draft
  const errored = !!state?.error && !draft
  const meta = asset ? KIND_META[asset.kind] : null

  const download = async (fmt: RenderFormat) => {
    if (!draft) return
    setDownloading(true)
    try { await downloadAsset(draft, fmt) } catch { /* ignore */ } finally { setDownloading(false) }
  }

  return (
    <>
      <div className={`cx__scrim${asset ? " is-open" : ""}`} onClick={onClose} />
      <aside className={`cx__drawer${asset ? " is-open" : ""}`} aria-hidden={!asset}>
        {asset && meta && (
          <>
            <header className="cx__drawer-head">
              <span className="cx__drawer-icon"><AssetIcon kind={asset.kind} size={18} /></span>
              <div className="cx__drawer-titles">
                <h2 className="cx__drawer-name">{draft?.title ?? asset.title}</h2>
                <p className="cx__drawer-blurb">{draft?.blurb ?? asset.summary}</p>
              </div>
              <button className="cx__drawer-close" onClick={onClose} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </header>
            <div className="cx__drawer-body">
              {draft ? (
                <DraftBody draft={draft} />
              ) : errored ? (
                <div className="cx__drawer-error">
                  <p className="cx__drawer-error-title">This asset didn’t build.</p>
                  <p className="cx__drawer-error-msg">{state?.error}</p>
                  <p className="cx__drawer-error-hint">Regenerate to try again.</p>
                </div>
              ) : (
                <p className="cx__drawer-empty">No content.</p>
              )}
            </div>
            <footer className="cx__drawer-foot">
              <button
                className="btn btn--ghost cx__drawer-regen"
                disabled={regenerating}
                onClick={() => onRegenerate(asset.id)}
                title="Generate a fresh version of this asset"
              >
                <Redo size={15} /> {regenerating ? "Regenerating…" : "Regenerate"}
              </button>
              <div className="cx__drawer-foot-right">
                <button className="btn btn--ghost" disabled={!draft} onClick={() => download("md")}>Markdown</button>
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
