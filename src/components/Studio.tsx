import { useEffect, useRef, useState } from "react"
import { Arrow, Check, Download, Layers, Redo } from "./icons"
import Logo from "./Logo"
import {
  streamGenerate, clarify as clarifyRequest, planPackage, buildEnrichedRequest, buildOpenInputs, buildConversationRequest,
  downloadAsset, downloadPackage, regenerateAsset, KIND_META,
  type PackagePlan, type PlanAsset, type AssetDraft,
  type GenerateEvent, type RenderFormat,
  type ClarifyQuestion, type ClarifyResult,
  type WorkspaceContext,
} from "../lib/api"

type Phase = "empty" | "streaming" | "clarifying" | "planning" | "ready" | "error"

type WorkspaceMode = "setup" | "edit" | null

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
  clarify: ClarifyResult | null
  clarifyAnswers: Record<string, string>
  openInputs?: string[]
  workspaceSnapshot?: WorkspaceContext
  errorMsg: string
}

interface WorkspaceDraft {
  organizationName: string
  organizationDescription: string
  workspacePurpose: string
  defaultAudience: string
  toneAndConstraints: string
  additionalContext: string
}

interface StudioProps { onBack: () => void }

// localStorage key for the persisted session (the package survives a refresh).
const STORAGE_KEY = "werk.session.v1"
const WORKSPACE_STORAGE_KEY = "werk.workspace.v1"
const FIRST_USE_GUIDE_STORAGE_KEY = "werk.studio-first-use-guide.v1"

const EMPTY_WORKSPACE_DRAFT: WorkspaceDraft = {
  organizationName: "",
  organizationDescription: "",
  workspacePurpose: "",
  defaultAudience: "",
  toneAndConstraints: "",
  additionalContext: "",
}

const EXAMPLES = [
  "Create a client proposal for my website design service.",
  "Plan the launch of my handmade skincare brand.",
  "Prepare a project kickoff for a new client.",
  "Make a job-search plan for a product manager role.",
]

function hasSeenFirstUseGuide(): boolean {
  try { return localStorage.getItem(FIRST_USE_GUIDE_STORAGE_KEY) === "1" } catch { return false }
}

function markFirstUseGuideSeen(): void {
  try { localStorage.setItem(FIRST_USE_GUIDE_STORAGE_KEY, "1") } catch { /* browser storage is optional */ }
}

function readWorkspaceContext(): WorkspaceContext | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<WorkspaceContext>
    const organizationName = typeof s.organizationName === "string" ? s.organizationName.trim() : ""
    const organizationDescription = typeof s.organizationDescription === "string" ? s.organizationDescription.trim() : ""
    const workspacePurpose = typeof s.workspacePurpose === "string" ? s.workspacePurpose.trim() : ""
    if (!organizationName || !organizationDescription || !workspacePurpose) return null
    const workspace: WorkspaceContext = {
      organizationName,
      organizationDescription,
      workspacePurpose,
    }
    const defaultAudience = typeof s.defaultAudience === "string" ? s.defaultAudience.trim() : ""
    if (defaultAudience) workspace.defaultAudience = defaultAudience
    const toneAndConstraints = typeof s.toneAndConstraints === "string" ? s.toneAndConstraints.trim() : ""
    if (toneAndConstraints) workspace.toneAndConstraints = toneAndConstraints
    const additionalContext = typeof s.additionalContext === "string" ? s.additionalContext.trim() : ""
    if (additionalContext) workspace.additionalContext = additionalContext
    return workspace
  } catch {
    return null
  }
}

function workspaceToDraft(workspace: WorkspaceContext): WorkspaceDraft {
  return {
    organizationName: workspace.organizationName,
    organizationDescription: workspace.organizationDescription,
    workspacePurpose: workspace.workspacePurpose,
    defaultAudience: workspace.defaultAudience ?? "",
    toneAndConstraints: workspace.toneAndConstraints ?? "",
    additionalContext: workspace.additionalContext ?? "",
  }
}

function draftToWorkspace(draft: WorkspaceDraft): WorkspaceContext | null {
  const organizationName = draft.organizationName.trim()
  const organizationDescription = draft.organizationDescription.trim()
  const workspacePurpose = draft.workspacePurpose.trim()
  if (!organizationName || !organizationDescription || !workspacePurpose) return null

  const workspace: WorkspaceContext = {
    organizationName,
    organizationDescription,
    workspacePurpose,
  }
  const defaultAudience = draft.defaultAudience.trim()
  if (defaultAudience) workspace.defaultAudience = defaultAudience
  const toneAndConstraints = draft.toneAndConstraints.trim()
  if (toneAndConstraints) workspace.toneAndConstraints = toneAndConstraints
  const additionalContext = draft.additionalContext.trim()
  if (additionalContext) workspace.additionalContext = additionalContext
  return workspace
}

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

export default function Studio({ onBack }: StudioProps) {
  const initialWorkspace = readWorkspaceContext()
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(initialWorkspace)
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDraft>(
    initialWorkspace ? workspaceToDraft(initialWorkspace) : EMPTY_WORKSPACE_DRAFT,
  )
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(initialWorkspace ? null : "setup")
  const [firstUseGuideSeen, setFirstUseGuideSeen] = useState(hasSeenFirstUseGuide)
  const [showFirstUseGuide, setShowFirstUseGuide] = useState(false)
  const [phase, setPhase] = useState<Phase>("empty")
  const [history, setHistory] = useState<ChatTurn[]>([])
  const [request, setRequest] = useState("")
  const [plan, setPlan] = useState<PackagePlan | null>(null)
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState("")
  const [clarify, setClarify] = useState<ClarifyResult | null>(null)
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>({})
  const [openInputs, setOpenInputs] = useState<string[]>([])
  const [clarifyError, setClarifyError] = useState("")
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null)
  const [downloadingPkg, setDownloadingPkg] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  // the request actually sent to generation (raw, or enriched with clarify
  // answers). Kept in a ref so a single-asset regenerate reuses the same
  // context instead of rerunning the whole package.
  const genRequestRef = useRef("")

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (!firstUseGuideSeen && workspace && !workspaceMode && phase === "empty") {
      setShowFirstUseGuide(true)
      setFirstUseGuideSeen(true)
      markFirstUseGuideSeen()
    }
  }, [firstUseGuideSeen, workspace, workspaceMode, phase])

  useEffect(() => {
    if (!showFirstUseGuide) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setShowFirstUseGuide(false) }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [showFirstUseGuide])

  /* ---- persistence: restore the active conversation on refresh ---- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const s = JSON.parse(raw) as {
        history?: ChatTurn[]; request?: string; plan?: PackagePlan | null;
        drafts?: Record<string, DraftState>; clarify?: ClarifyResult | null;
        clarifyAnswers?: Record<string, string>; openInputs?: string[]; genRequest?: string;
      }
      if (!s.request && !s.plan && !s.history?.length) return
      const active = restoreTurn({
        request: s.request || "",
        plan: s.plan ?? null,
        drafts: s.drafts ?? {},
        clarify: s.clarify ?? null,
        clarifyAnswers: s.clarifyAnswers ?? {},
        openInputs: s.openInputs ?? [],
        errorMsg: "",
      })
      genRequestRef.current = s.genRequest || active.request
      setHistory(Array.isArray(s.history) ? s.history.map(restoreTurn) : [])
      setRequest(active.request)
      setPlan(active.plan)
      setDrafts(active.drafts)
      setClarify(active.clarify)
      setClarifyAnswers(active.clarifyAnswers)
      setOpenInputs(active.openInputs ?? [])
      setPhase(active.plan ? "ready" : "empty")
    } catch { /* ignore corrupt storage */ }
  }, [])

  useEffect(() => {
    try {
      if (workspace) {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace))
      } else {
        localStorage.removeItem(WORKSPACE_STORAGE_KEY)
      }
    } catch { /* ignore quota */ }
  }, [workspace])

  // Persist stable turns only. A refresh during generation is deliberately not
  // saved, so it cannot restore a partially-built follow-up as complete.
  useEffect(() => {
    if (phase === "streaming") return
    const snap = {
      history, request, plan, drafts, clarify, clarifyAnswers, openInputs,
      genRequest: genRequestRef.current,
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)) } catch { /* ignore quota */ }
  }, [history, request, plan, drafts, clarify, clarifyAnswers, openInputs, phase])

  // keep the thread pinned to the latest content as drafts stream in
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history, request, plan, drafts, phase, clarify, clarifyAnswers])

  const openWorkspaceEditor = (mode: WorkspaceMode) => {
    setWorkspaceDraft(mode === "edit" && workspace ? workspaceToDraft(workspace) : EMPTY_WORKSPACE_DRAFT)
    setWorkspaceMode(mode)
  }

  const saveWorkspace = () => {
    const next = draftToWorkspace(workspaceDraft)
    if (!next) return
    setWorkspace(next)
    setWorkspaceDraft(workspaceToDraft(next))
    setWorkspaceMode(null)
  }

  const cancelWorkspaceEdit = () => {
    setWorkspaceDraft(workspace ? workspaceToDraft(workspace) : EMPTY_WORKSPACE_DRAFT)
    setWorkspaceMode(null)
  }

  const dismissFirstUseGuide = () => setShowFirstUseGuide(false)

  const start = (text: string) => {
    const value = text.trim()
    if (!value || !workspace) { if (!workspace) openWorkspaceEditor("setup"); return }
    const currentTurn: ChatTurn | null = request
      ? { request, plan, drafts, clarify, clarifyAnswers, openInputs, workspaceSnapshot: workspace, errorMsg }
      : null
    const contextTurns = [...history, ...(currentTurn ? [currentTurn] : [])].map((turn) => ({
      request: turn.request, reply: turn.plan?.reply, packageTitle: turn.plan?.packageTitle, assets: turn.plan?.assets,
      knownDetails: turn.plan?.brief.knownDetails, openInputs: turn.openInputs,
    }))
    const contextualRequest = buildConversationRequest(contextTurns, value)
    abortRef.current?.abort(); const ctrl = new AbortController(); abortRef.current = ctrl
    genRequestRef.current = contextualRequest
    if (currentTurn) setHistory((turns) => [...turns, currentTurn])
    setRequest(value); setPlan(null); setDrafts({}); setOpenId(null); setErrorMsg(""); setClarify(null); setClarifyAnswers({}); setOpenInputs([]); setClarifyError(""); setPhase("streaming")
    clarifyRequest(contextualRequest, workspace, [], ctrl.signal).then((res) => {
      if (res.mode === "clarify" && res.questions.length) { setClarify(res); setPhase("clarifying") }
      else runPlan(contextualRequest, workspace, [])
    }).catch((err) => { if (err?.name !== "AbortError") { setErrorMsg(err?.message ?? "Request failed"); setPhase("error") } })
  }

  const runPlan = (req: string, workspaceContext: WorkspaceContext, inputs: string[]) => {
    abortRef.current?.abort(); const ctrl = new AbortController(); abortRef.current = ctrl
    genRequestRef.current = req; setPhase("streaming")
    planPackage(req, workspaceContext, inputs, ctrl.signal).then((nextPlan) => {
      const combinedInputs = [...new Set([...inputs, ...nextPlan.brief.openInputs])]
      setOpenInputs(combinedInputs); setPlan({ ...nextPlan, brief: { ...nextPlan.brief, openInputs: combinedInputs } }); setPhase("planning")
    }).catch((err) => { if (err?.name !== "AbortError") { setErrorMsg(err?.message ?? "Planning failed"); setPhase("error") } })
  }

  const approvePlan = () => {
    if (!plan || !workspace) return
    abortRef.current?.abort(); const ctrl = new AbortController(); abortRef.current = ctrl
    setPhase("streaming")
    streamGenerate(genRequestRef.current, workspace, plan, openInputs, (e: GenerateEvent) => {
      if (e.type === "plan") { setPlan(e.plan); setDrafts(Object.fromEntries(e.plan.assets.map((a) => [a.id, { done: false, status: "queued" }]))) }
      else if (e.type === "asset-status") setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], status: e.status, done: false } }))
      else if (e.type === "quality-warning") setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], warning: e.issues.map((issue) => issue.message).join(" ") } }))
      else if (e.type === "draft") setDrafts((d) => { const previous = d[e.id]; const versions = [...(previous?.versions ?? (previous?.draft ? [previous.draft] : [])), e.draft]; return { ...d, [e.id]: { draft: e.draft, versions, done: true } } })
      else if (e.type === "draft-error") setDrafts((d) => ({ ...d, [e.id]: { ...d[e.id], error: e.message, done: true } }))
      else if (e.type === "done") setPhase("ready")
      else if (e.type === "error") { setErrorMsg(e.message); setPhase("error") }
    }, ctrl.signal).catch((err) => { if (err?.name !== "AbortError") { setErrorMsg(err?.message ?? "Request failed"); setPhase("error") } })
  }

  const submitClarify = (allowOpenInputs = false) => {
    if (!clarify || !workspace) return
    const missingRequired = clarify.questions.filter((q) => q.required && !(clarifyAnswers[q.key] ?? "").trim())
    if (missingRequired.length && !allowOpenInputs) { setClarifyError("Answer the required question or choose to keep it visible as an open input."); return }
    const enriched = buildEnrichedRequest(genRequestRef.current, clarify.questions, clarifyAnswers)
    const inputs = buildOpenInputs(clarify.questions, clarifyAnswers)
    setClarifyError(""); runPlan(enriched, workspace, inputs)
  }

  const onAnswerChange = (key: string, val: string) => {
    setClarifyAnswers((a) => ({ ...a, [key]: val }))
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
    setClarify(null)
    setClarifyAnswers({})
    setOpenInputs([])
    setClarifyError("")
    setRegeneratingId(null)
    genRequestRef.current = ""
  }

  // regenerate a single asset in place, reusing the same request context the
  // package was built from (so the new draft still tracks the original ask).
  const regenerate = (id: string, instruction?: string) => {
    const asset = plan?.assets.find((a) => a.id === id)
    if (!asset || !plan || regeneratingId || !workspace) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRegeneratingId(id)
    setDrafts((d) => ({ ...d, [id]: { ...d[id], status: "revising", done: false, error: undefined } }))
    regenerateAsset(asset, genRequestRef.current, workspace, plan.brief, openInputs, drafts[id]?.draft, instruction, ctrl.signal)
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
  // "Download package" zip contains.
  const doneItems = plan?.assets
    .filter((a) => drafts[a.id]?.draft)
    .map((a) => ({ draft: drafts[a.id]!.draft!, format: KIND_META[a.kind].format })) ?? []
  const canDownloadPkg = !!plan && phase === "ready" && doneItems.length === plan.assets.length

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
            <span className="cx__pill"><span className="cx__pill-dot" /> {assetCount} outputs</span>
          )}
        </div>

        <div className="cx__body">
          {/* sidebar — the package WERK assembled (hidden on narrow viewports) */}
          <aside className="cx__side">
            <p className="cx__side-label"><Layers size={12} /> Outputs</p>
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
              <div className="cx__workspace-card">
                <p className="cx__workspace-label"><Layers size={12} /> Workspace</p>
                {workspace ? (
                  <>
                    <p className="cx__workspace-name">{workspace.organizationName}</p>
                    <p className="cx__workspace-copy">{workspace.workspacePurpose}</p>
                  </>
                ) : (
                  <p className="cx__workspace-copy">Set the workspace context to unlock the chat.</p>
                )}
                <button className="cx__side-act cx__side-act--full" onClick={() => openWorkspaceEditor(workspace ? "edit" : "setup")}>
                  {workspace ? "Edit saved details" : "Add saved details"}
                </button>
              </div>
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
            {workspaceMode || !workspace ? (
              <WorkspaceSetup
                mode={workspace ? workspaceMode ?? "edit" : "setup"}
                draft={workspaceDraft}
                onChange={setWorkspaceDraft}
                onSave={saveWorkspace}
                onCancel={workspace ? cancelWorkspaceEdit : undefined}
                canSave={!!draftToWorkspace(workspaceDraft)}
                workspaceName={workspace?.organizationName}
              />
            ) : phase === "empty" ? (
              <Empty onStart={start} showFirstUseGuide={showFirstUseGuide} onDismissFirstUseGuide={dismissFirstUseGuide} />
            ) : phase === "planning" && plan ? (
              <PackageReview plan={plan} onChange={setPlan} onCreate={approvePlan} />
            ) : (
              <Thread
                threadRef={threadRef}
                workspace={workspace}
                history={history}
                request={request}
                plan={plan}
                drafts={drafts}
                phase={phase}
                errorMsg={errorMsg}
                clarify={clarify}
                clarifyAnswers={clarifyAnswers}
                clarifyError={clarifyError}
                onAnswerChange={onAnswerChange}
                onSubmitClarify={submitClarify}
                onOpen={setOpenId}
                onSend={start}
                onDownloadPkg={downloadPkg}
                downloadingPkg={downloadingPkg}
                canDownloadPkg={canDownloadPkg}
                onEditWorkspace={() => openWorkspaceEditor("edit")}
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
function Empty({ onStart, showFirstUseGuide, onDismissFirstUseGuide }: { onStart: (text: string) => void; showFirstUseGuide: boolean; onDismissFirstUseGuide: () => void }) {
  return (
    <div className="cx__empty">
      <div className="cx__empty-inner">
        <h1 className="cx__greeting">What do you need?</h1>
        <p className="cx__greeting-sub">
          Describe the outcome in plain language. WERK suggests the useful documents and plans, then lets you review them before it writes.
        </p>
        {showFirstUseGuide && <FirstUseGuide onDismiss={onDismissFirstUseGuide} />}
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

function FirstUseGuide({ onDismiss }: { onDismiss: () => void }) {
  return (
    <aside className="cx__first-use-guide" aria-label="How WERK works">
      <button className="cx__first-use-close" onClick={onDismiss} aria-label="Dismiss guide">×</button>
      <div className="cx__first-use-head">
        <span className="cx__first-use-kicker">New here?</span>
        <h2>How WERK works</h2>
      </div>
      <ol className="cx__first-use-steps">
        <li><b>Describe the outcome.</b><span>Tell WERK what you are trying to do.</span></li>
        <li><b>Keep the important details honest.</b><span>Answer the useful questions, or leave an input visibly open.</span></li>
        <li><b>Review, then create.</b><span>Choose the suggested outputs before WERK drafts them.</span></li>
      </ol>
      <p className="cx__first-use-note">Your saved details stay in this browser.</p>
      <div className="cx__first-use-actions">
        <button className="btn btn--ghost" onClick={onDismiss}>Skip</button>
        <button className="btn btn--primary" onClick={onDismiss}>Got it <Arrow size={14} className="arrow" /></button>
      </div>
    </aside>
  )
}

function PackageReview({ plan, onChange, onCreate }: { plan: PackagePlan; onChange: (plan: PackagePlan) => void; onCreate: () => void }) {
  const updateBrief = (field: "objective" | "audience" | "decision" | "timing", value: string) => onChange({ ...plan, brief: { ...plan.brief, [field]: value } })
  const toggleAsset = (id: string) => {
    if (plan.assets.length === 1) return
    onChange({ ...plan, assets: plan.assets.filter((asset) => asset.id !== id) })
  }
  return (
    <div className="cx__setup-screen cx__review-screen">
      <div className="cx__setup-card cx__review-card">
        <p className="cx__setup-kicker">Suggested outputs</p>
        <h1 className="cx__setup-title">Review before WERK writes</h1>
        <p className="cx__setup-copy">WERK will use only the details shown below. Anything else stays marked as needing your input.</p>
        <div className="cx__setup-grid">
          <WorkspaceField label="What you need to achieve" value={plan.brief.objective} onChange={(value) => updateBrief("objective", value)} placeholder="The outcome you need" required wide />
          <WorkspaceField label="Who this is for" value={plan.brief.audience} onChange={(value) => updateBrief("audience", value)} placeholder="Needs your input: audience" wide />
          <WorkspaceField label="Desired next step" value={plan.brief.decision} onChange={(value) => updateBrief("decision", value)} placeholder="Needs your input: desired next step" wide />
          <WorkspaceField label="Timing" value={plan.brief.timing} onChange={(value) => updateBrief("timing", value)} placeholder="Needs your input: timing" wide />
        </div>
        {plan.brief.knownDetails.length > 0 && <div className="cx__review-list"><strong>Details supplied</strong>{plan.brief.knownDetails.map((detail) => <span key={detail}>{detail}</span>)}</div>}
        {plan.brief.openInputs.length > 0 && <div className="cx__review-list cx__review-list--open"><strong>Details to confirm</strong>{plan.brief.openInputs.map((detail) => <span key={detail}>{detail}</span>)}</div>}
        <div className="cx__review-assets">
          {plan.assets.map((asset) => <label className="cx__review-asset" key={asset.id}><input type="checkbox" checked onChange={() => toggleAsset(asset.id)} /><span><b>{KIND_META[asset.kind].label}</b><small>{asset.summary}</small></span></label>)}
        </div>
        <div className="cx__setup-actions"><button className="btn btn--primary" onClick={onCreate}>Create {plan.assets.length} draft{plan.assets.length === 1 ? "" : "s"} <Arrow size={15} className="arrow" /></button></div>
      </div>
    </div>
  )
}

/* ---- the conversation thread (chat pane) ---- */
function Thread({
  threadRef, workspace, history, request, plan, drafts, phase, errorMsg,
  clarify, clarifyAnswers, clarifyError, onAnswerChange, onSubmitClarify, onOpen, onSend,
  onDownloadPkg, downloadingPkg, canDownloadPkg, onEditWorkspace,
}: {
  threadRef: React.RefObject<HTMLDivElement>
  workspace: WorkspaceContext | null
  history: ChatTurn[]
  request: string
  plan: PackagePlan | null
  drafts: Record<string, DraftState>
  phase: Phase
  errorMsg: string
  clarify: ClarifyResult | null
  clarifyAnswers: Record<string, string>
  clarifyError: string
  onAnswerChange: (key: string, val: string) => void
  onSubmitClarify: (allowOpenInputs?: boolean) => void
  onOpen: (id: string) => void
  onSend: (text: string) => void
  onDownloadPkg: () => void
  downloadingPkg: boolean
  canDownloadPkg: boolean
  onEditWorkspace: () => void
}) {
  const doneCount = Object.values(drafts).filter((d) => d.done).length
  const total = plan?.assets.length ?? 0

  return (
    <>
      <div className="cx__thread" ref={threadRef}>
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
                  <span className="cx__clarify-q">{q.question}{q.required ? " *" : ""}</span>
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
              {clarifyError && <p className="cx__quality-note">{clarifyError}</p>}
              <div className="cx__clarify-foot">
                <button className="btn btn--primary" onClick={() => onSubmitClarify()}>
                  Review suggestions <Arrow size={15} className="arrow" />
                </button>
                <button className="btn btn--ghost" onClick={() => onSubmitClarify(true)}>
                  Keep unanswered items visible
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="cx__composer-dock">
        <div className="cx__composer-wrap">
          <Composer
            onSend={onSend}
            placeholder="Make another request…"
            disabled={phase === "streaming" || phase === "clarifying"}
          />
        </div>
      </div>
    </>
  )
}

function WorkspaceSetup({
  mode, draft, onChange, onSave, onCancel, canSave, workspaceName,
}: {
  mode: Exclude<WorkspaceMode, null>
  draft: WorkspaceDraft
  onChange: (draft: WorkspaceDraft) => void
  onSave: () => void
  onCancel?: () => void
  canSave: boolean
  workspaceName?: string
}) {
  const update = (field: keyof WorkspaceDraft, value: string) => onChange({ ...draft, [field]: value })

  return (
    <div className="cx__setup-screen">
      <div className="cx__setup-card">
        <p className="cx__setup-kicker">Workspace context</p>
        <h1 className="cx__setup-title">
          {mode === "setup" ? "Set the workspace context" : "Edit the workspace context"}
        </h1>
        <p className="cx__setup-copy">
          This gives WERK helpful background for repeat requests. Use your name, team, business, client, or project.
        </p>
        {workspaceName && mode === "edit" && (
          <p className="cx__setup-note">Editing {workspaceName}.</p>
        )}
        <p className="cx__setup-example">
          Example: Maya Studio / independent web designer / client proposals, launch plans, and project handovers.
        </p>

        <div className="cx__setup-grid">
          <WorkspaceField
            label="Your name, team, business, or client"
            value={draft.organizationName}
            onChange={(value) => update("organizationName", value)}
            placeholder="Maya Studio"
            required
            wide
          />
          <WorkspaceField
            label="What they do"
            value={draft.organizationDescription}
            onChange={(value) => update("organizationDescription", value)}
            placeholder="Independent web designer for small businesses"
            multiline
            rows={3}
            required
            wide
          />
          <WorkspaceField
            label="What this workspace is for"
            value={draft.workspacePurpose}
            onChange={(value) => update("workspacePurpose", value)}
            placeholder="Client proposals, launch plans, and project handovers"
            multiline
            rows={3}
            required
            wide
          />
          <WorkspaceField
            label="Default audience"
            value={draft.defaultAudience}
            onChange={(value) => update("defaultAudience", value)}
            placeholder="Exec team"
          />
          <WorkspaceField
            label="Tone or constraints"
            value={draft.toneAndConstraints}
            onChange={(value) => update("toneAndConstraints", value)}
            placeholder="Direct, no fluff, numbers first"
          />
          <WorkspaceField
            label="Additional context"
            value={draft.additionalContext}
            onChange={(value) => update("additionalContext", value)}
            placeholder="Launch dates, brand notes, or key stakeholders"
            multiline
            rows={3}
            wide
          />
        </div>

        <div className="cx__setup-actions">
          {onCancel && (
            <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          )}
          <button className="btn btn--primary" onClick={onSave} disabled={!canSave}>
            {mode === "setup" ? "Save workspace" : "Update workspace"} <Arrow size={15} className="arrow" />
          </button>
        </div>
      </div>
    </div>
  )
}

function WorkspaceField({
  label, value, onChange, placeholder, multiline = false, rows = 2, required = false, wide = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  multiline?: boolean
  rows?: number
  required?: boolean
  wide?: boolean
}) {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  return (
    <label className={`cx__setup-field${wide ? " cx__setup-field--wide" : ""}`} htmlFor={id}>
      <span className="cx__setup-label">{label}{required ? " *" : ""}</span>
      {multiline ? (
        <textarea
          id={id}
          className="cx__setup-input cx__setup-input--textarea"
          value={value}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <input
          id={id}
          className="cx__setup-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          type="text"
        />
      )}
    </label>
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
          {turn.clarify?.reply && !turn.plan && <p className="cx__reply">{turn.clarify.reply}</p>}
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
  onRegenerate: (id: string, instruction?: string) => void
  onClose: () => void
}) {
  const [downloading, setDownloading] = useState(false)
  const versions = state?.versions ?? (state?.draft ? [state.draft] : [])
  const [selectedVersion, setSelectedVersion] = useState(0)
  const [revisionInstruction, setRevisionInstruction] = useState("")

  useEffect(() => {
    setSelectedVersion(Math.max(0, versions.length - 1))
  }, [asset?.id, versions.length])

  useEffect(() => {
    if (!asset) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [asset, onClose])

  const draft = versions[selectedVersion] ?? state?.draft
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
              <button className="cx__drawer-close" onClick={onClose} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </header>
            <div className="cx__drawer-body">
              {draft ? (
                <>
                  {state?.warning && <p className="cx__quality-note">Quality note: {state.warning}</p>}
                  {(draft.metadata?.gaps.length ?? 0) > 0 && <div className="cx__review-list cx__review-list--open"><strong>Details to confirm</strong>{draft.metadata!.gaps.map((gap) => <span key={gap}>{gap}</span>)}</div>}
                  <DraftBody draft={draft} />
                </>
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
              <div className="cx__drawer-revise">
                <input value={revisionInstruction} onChange={(e) => setRevisionInstruction(e.target.value)} placeholder="What should change?" />
                <button
                  className="btn btn--ghost cx__drawer-regen"
                  disabled={regenerating}
                  onClick={() => onRegenerate(asset.id, revisionInstruction || undefined)}
                  title="Create a revised version using this instruction"
                >
                  <Redo size={15} /> {regenerating ? "Revising…" : "Revise"}
                </button>
              </div>
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
