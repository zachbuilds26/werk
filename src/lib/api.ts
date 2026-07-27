// Client types + API helpers for the WERK workspace. Shapes mirror the server
// (server/src/types.ts). The workspace drives everything through the SSE
// /api/generate stream, then downloads finished assets via /api/render.

export type AssetKind =
  | "deck" | "document" | "sheet" | "agenda" | "actions" | "timeline"

export type RenderFormat = "md" | "pdf" | "pptx" | "xlsx"

export interface PlanAsset {
  id: string
  kind: AssetKind
  title: string
  summary: string
}

export interface PackagePlan {
  packageName: string
  packageTitle: string
  reply: string
  assets: PlanAsset[]
}

export interface ClarifyQuestion {
  key: string
  question: string
  placeholder?: string
}

export interface ClarifyResult {
  mode: "clarify" | "ready"
  reply: string
  questions: ClarifyQuestion[]
}

export interface Slide { eyebrow: string; title: string; bullets: string[] }
export interface DocSection { heading: string; body: string[] }
export interface TableData { columns: string[]; rows: string[][] }
export interface AgendaItem { time: string; topic: string; owner: string }
export interface ActionItem { task: string; owner: string; due: string }
export interface TimelinePhase { phase: string; window: string; detail: string }

export interface AssetDraft {
  kind: AssetKind
  title: string
  blurb: string
  slides?: Slide[]
  sections?: DocSection[]
  table?: TableData
  agenda?: AgendaItem[]
  actions?: ActionItem[]
  timeline?: TimelinePhase[]
}

// SSE events emitted by POST /api/generate.
export type GenerateEvent =
  | { type: "plan"; plan: PackagePlan }
  | { type: "draft"; id: string; draft: AssetDraft }
  | { type: "draft-error"; id: string; message: string }
  | { type: "done" }
  | { type: "error"; message: string }

// Per-kind default download format + a short label for the UI.
export const KIND_META: Record<AssetKind, { label: string; format: RenderFormat; formatLabel: string }> = {
  deck: { label: "Presentation", format: "pptx", formatLabel: "PPTX" },
  document: { label: "Document", format: "pdf", formatLabel: "PDF" },
  sheet: { label: "Spreadsheet", format: "xlsx", formatLabel: "XLSX" },
  agenda: { label: "Agenda", format: "pdf", formatLabel: "PDF" },
  actions: { label: "Action items", format: "pdf", formatLabel: "PDF" },
  timeline: { label: "Timeline", format: "pdf", formatLabel: "PDF" },
}

/**
 * POST /api/clarify to decide whether WERK needs a few details before it
 * builds. Returns mode "clarify" with up to 4 questions, or "ready" to go
 * straight to generation. Throws on a non-2xx response.
 */
export async function clarify(request: string, signal?: AbortSignal): Promise<ClarifyResult> {
  const res = await fetch("/api/clarify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
    signal,
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try { message = (await res.json()).error ?? message } catch { /* keep default */ }
    throw new Error(message)
  }
  return (await res.json()) as ClarifyResult
}

/**
 * Fold clarify answers into the request as a "Context:" block (the shape the
 * plan and draft prompts already look for). Only questions with a non-empty
 * answer are included; unanswered ones are left out so the model can fall back
 * to placeholders for still-missing details.
 */
export function buildEnrichedRequest(
  request: string,
  questions: ClarifyQuestion[],
  answers: Record<string, string>,
): string {
  const lines = questions
    .map((q) => ({ q, a: (answers[q.key] ?? "").trim() }))
    .filter((x) => x.a)
    .map((x) => `- ${x.q.question} ${x.a}`)
  if (lines.length === 0) return request
  return `${request.trim()}\n\nContext:\n${lines.join("\n")}`
}

/**
 * POST /api/generate and read the server-sent event stream. Each frame is a
 * GenerateEvent: a "plan" first, then one "draft" per asset (or "draft-error"
 * if a single asset fails), then "done". onEvent runs once per frame. Throws
 * only on a network failure; server-side errors arrive as { type: "error" }.
 */
export async function streamGenerate(
  request: string,
  onEvent: (e: GenerateEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
    signal,
  })

  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`
    try { message = (await res.json()).error ?? message } catch { /* keep default */ }
    onEvent({ type: "error", message })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  // SSE frames are separated by a blank line; each data line is JSON.
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split("\n\n")
    buffer = frames.pop() ?? ""
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"))
      if (!line) continue
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as GenerateEvent)
      } catch { /* ignore malformed frame */ }
    }
  }
}

/**
 * POST /api/draft to regenerate ONE asset (same endpoint the generate stream
 * uses per asset). Returns the new draft so the caller can swap it into the
 * package without rerunning the whole set. Throws on a non-2xx response.
 */
export async function regenerateAsset(
  kind: AssetKind,
  title: string,
  request: string,
  signal?: AbortSignal
): Promise<AssetDraft> {
  const res = await fetch("/api/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, title, request }),
    signal,
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try { message = (await res.json()).error ?? message } catch { /* keep default */ }
    throw new Error(message)
  }
  return (await res.json()) as AssetDraft
}

/** POST /api/render and trigger a browser download of the returned file. */
export async function downloadAsset(draft: AssetDraft, format: RenderFormat): Promise<void> {
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, format }),
  })
  if (!res.ok) throw new Error(`Render failed (${res.status})`)

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const safe = (draft.title || "asset").replace(/[^a-z0-9\-_ ]/gi, "").trim() || "asset"
  const a = document.createElement("a")
  a.href = url
  a.download = `${safe}.${format}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** One asset to include in a package download, paired with its render format. */
export interface PackageItem {
  draft: AssetDraft
  format: RenderFormat
}

/**
 * POST /api/package and trigger a browser download of the returned zip. The
 * server renders each item to its native format and bundles them with a short
 * index, so the whole package lands as one file. Throws on a non-2xx response.
 */
export async function downloadPackage(packageName: string, items: PackageItem[]): Promise<void> {
  const res = await fetch("/api/package", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageName, items }),
  })
  if (!res.ok) throw new Error(`Package failed (${res.status})`)

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const safe = (packageName || "package").replace(/[^a-z0-9\-_ ]/gi, "").trim() || "package"
  const a = document.createElement("a")
  a.href = url
  a.download = `${safe}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
