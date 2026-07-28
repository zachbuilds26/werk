// Client types + API helpers for the WERK workspace. The server owns the
// canonical workspace block; the browser keeps only the user's request and
// visible open inputs.

export type AssetKind = "deck" | "document" | "sheet" | "agenda" | "actions" | "timeline"
export type RenderFormat = "md" | "pdf" | "pptx" | "xlsx"

export interface PlanAsset {
  id: string; kind: AssetKind; title: string; summary: string; purpose: string; audience: string; decision: string
  requiredAnalysis: string[]; acceptanceCriteria: string[]; evidenceIds: string[]; dependencies: string[]
}

export interface PackageBrief {
  objective: string; audience: string; decision: string; timing: string
  knownDetails: string[]; openInputs: string[]; sharedTerms: string[]; consistencyRules: string[]
}

export interface PackagePlan { packageName: string; packageTitle: string; reply: string; brief: PackageBrief; assets: PlanAsset[] }
export interface ClarifyQuestion { key: string; question: string; placeholder?: string; required?: boolean }
export interface ClarifyResult { mode: "clarify" | "ready"; reply: string; questions: ClarifyQuestion[] }

export interface WorkspaceContext {
  organizationName: string; organizationDescription: string; workspacePurpose: string
  defaultAudience?: string; toneAndConstraints?: string; additionalContext?: string
}

export interface Slide { eyebrow: string; title: string; bullets: string[] }
export interface DocSection { heading: string; body: string[] }
export interface TableData { columns: string[]; rows: string[][] }
export interface AgendaItem { time: string; topic: string; owner: string }
export interface ActionItem { task: string; owner: string; due: string }
export interface TimelinePhase { phase: string; window: string; detail: string }
export interface QualityIssue { code: string; message: string; severity: "error" | "warning"; path?: string }
export interface DraftMetadata { evidenceIds: string[]; assumptions: string[]; gaps: string[]; quality: QualityIssue[]; revision: number }
export interface AssetDraft {
  kind: AssetKind; title: string; blurb: string; slides?: Slide[]; sections?: DocSection[]; table?: TableData
  agenda?: AgendaItem[]; actions?: ActionItem[]; timeline?: TimelinePhase[]; metadata?: DraftMetadata
}

export type GenerateEvent =
  | { type: "job-started"; jobId: string; sequence: number }
  | { type: "plan"; jobId: string; sequence: number; plan: PackagePlan }
  | { type: "asset-status"; jobId: string; sequence: number; id: string; status: "queued" | "drafting" | "verifying" | "revising" }
  | { type: "quality-warning"; jobId: string; sequence: number; id: string; issues: QualityIssue[] }
  | { type: "draft"; jobId: string; sequence: number; id: string; draft: AssetDraft }
  | { type: "draft-error"; jobId: string; sequence: number; id: string; message: string }
  | { type: "done"; jobId: string; sequence: number }
  | { type: "error"; jobId: string; sequence: number; message: string }

export const KIND_META: Record<AssetKind, { label: string; format: RenderFormat; formatLabel: string }> = {
  deck: { label: "Presentation", format: "pptx", formatLabel: "PPTX" },
  document: { label: "Document", format: "pdf", formatLabel: "PDF" },
  sheet: { label: "Spreadsheet", format: "xlsx", formatLabel: "XLSX" },
  agenda: { label: "Meeting plan", format: "pdf", formatLabel: "PDF" },
  actions: { label: "Task list", format: "pdf", formatLabel: "PDF" },
  timeline: { label: "Schedule", format: "pdf", formatLabel: "PDF" },
}

export interface ConversationContextTurn { request: string; reply?: string; packageTitle?: string; assets?: Pick<PlanAsset, "kind" | "title">[]; knownDetails?: string[]; openInputs?: string[] }

export function buildConversationRequest(turns: ConversationContextTurn[], request: string): string {
  const current = request.trim()
  if (turns.length === 0) return current
  const history = turns.slice(-4).map((turn, index) => {
    const assets = turn.assets?.map((asset) => `${asset.kind}: ${asset.title}`).join("; ")
    return [
      `Earlier request ${index + 1}: ${turn.request.trim()}`,
      turn.knownDetails?.length ? `User-confirmed details: ${turn.knownDetails.join(" | ")}` : "",
      turn.openInputs?.length ? `Still open: ${turn.openInputs.join(" | ")}` : "",
      turn.packageTitle ? `Earlier output set: ${turn.packageTitle}` : "",
      assets ? `Outputs: ${assets}` : "",
    ].filter(Boolean).join("\n")
  }).join("\n\n")
  return `Earlier work:\n${history}\n\nNew user request: ${current}`.slice(-6000)
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try { message = (await res.json()).error ?? message } catch { /* keep default */ }
    throw new Error(message)
  }
  return (await res.json()) as T
}

export function clarify(request: string, workspaceContext: WorkspaceContext, openInputs: string[] = [], signal?: AbortSignal): Promise<ClarifyResult> {
  return postJson("/api/clarify", { request, workspaceContext, openInputs }, signal)
}

export function planPackage(request: string, workspaceContext: WorkspaceContext, openInputs: string[] = [], signal?: AbortSignal): Promise<PackagePlan> {
  return postJson("/api/plan", { request, workspaceContext, openInputs }, signal)
}

export function buildEnrichedRequest(request: string, questions: ClarifyQuestion[], answers: Record<string, string>): string {
  const lines = questions.map((q) => ({ q, a: (answers[q.key] ?? "").trim() })).filter((x) => x.a).map((x) => `- ${x.q.question} ${x.a}`)
  return lines.length ? `${request.trim()}\n\nContext:\n${lines.join("\n")}` : request.trim()
}

export function buildOpenInputs(questions: ClarifyQuestion[], answers: Record<string, string>): string[] {
  return questions.filter((q) => !(answers[q.key] ?? "").trim()).map((q) => `Needs your input: ${q.question}`)
}

export async function streamGenerate(request: string, workspaceContext: WorkspaceContext, plan: PackagePlan, openInputs: string[], onEvent: (event: GenerateEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request, workspaceContext, plan, openInputs }), signal })
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`
    try { message = (await res.json()).error ?? message } catch { /* keep default */ }
    onEvent({ type: "error", jobId: "local", sequence: 0, message }); return
  }
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ""
  while (true) {
    const { value, done } = await reader.read(); if (done) break
    buffer += decoder.decode(value, { stream: true }); const frames = buffer.split("\n\n"); buffer = frames.pop() ?? ""
    for (const frame of frames) {
      const line = frame.split("\n").find((value) => value.startsWith("data:"))
      if (!line) continue
      try { onEvent(JSON.parse(line.slice(5).trim()) as GenerateEvent) } catch { /* ignore malformed frame */ }
    }
  }
}

export function regenerateAsset(asset: PlanAsset, request: string, workspaceContext: WorkspaceContext, brief: PackageBrief, openInputs: string[], previousDraft?: AssetDraft, revisionInstruction?: string, signal?: AbortSignal): Promise<AssetDraft> {
  return postJson("/api/draft", { kind: asset.kind, title: asset.title, assetPlan: asset, request, workspaceContext, brief, openInputs, previousDraft, revisionInstruction }, signal)
}

export async function downloadAsset(draft: AssetDraft, format: RenderFormat): Promise<void> {
  const res = await fetch("/api/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft, format }) })
  if (!res.ok) throw new Error(`Render failed (${res.status})`)
  const blob = await res.blob(); const url = URL.createObjectURL(blob); const safe = (draft.title || "output").replace(/[^a-z0-9\-_ ]/gi, "").trim() || "output"
  const a = document.createElement("a"); a.href = url; a.download = `${safe}.${format}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

export interface PackageItem { draft: AssetDraft; format: RenderFormat }
export async function downloadPackage(packageName: string, items: PackageItem[]): Promise<void> {
  const res = await fetch("/api/package", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageName, items }) })
  if (!res.ok) throw new Error(`Package failed (${res.status})`)
  const blob = await res.blob(); const url = URL.createObjectURL(blob); const safe = (packageName || "package").replace(/[^a-z0-9\-_ ]/gi, "").trim() || "package"
  const a = document.createElement("a"); a.href = url; a.download = `${safe}.zip`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}
