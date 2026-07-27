// Shared shapes for the werk API. The plan endpoint decides which assets a
// request needs; the draft endpoint fills one asset with structured content;
// the render endpoint turns that content into a real file.

export type AssetKind =
  | "deck" // a board / pitch / review presentation (slides)
  | "document" // an executive summary, report, or brief (headed prose)
  | "sheet" // a financial model, budget, or spreadsheet (a table)
  | "agenda" // a meeting agenda (time, topic, owner)
  | "actions" // an action-items list (task, owner, due)
  | "timeline"; // a project timeline or roadmap (phase, window, detail)

export const ASSET_KINDS: readonly AssetKind[] = [
  "deck",
  "document",
  "sheet",
  "agenda",
  "actions",
  "timeline",
];

export interface PlanAsset {
  /** Client-side key, assigned by the server (a1, a2, ...). */
  id: string;
  kind: AssetKind;
  title: string;
  summary: string;
}

export interface PackagePlan {
  /** Short label for the whole package, e.g. "Board pack". */
  packageName: string;
  /** Concrete name derived from the request, e.g. "Q3 board review". */
  packageTitle: string;
  /** One short sentence in WERK's voice. */
  reply: string;
  assets: PlanAsset[];
}

/** One targeted question asked before a package is built. */
export interface ClarifyQuestion {
  /** Short slug used as the client-side key for the answer, e.g. "audience". */
  key: string;
  /** One-sentence question shown to the user. */
  question: string;
  /** Optional example answer shown as the input placeholder. */
  placeholder?: string;
}

/** Result of the clarify step: either ask questions, or signal "ready". */
export interface ClarifyResult {
  mode: "clarify" | "ready";
  /** When clarifying, a friendly line saying a few details are needed. */
  reply: string;
  /** Questions to ask; empty when mode is "ready". */
  questions: ClarifyQuestion[];
}

export interface Slide {
  eyebrow: string;
  title: string;
  bullets: string[];
}

export interface DocSection {
  heading: string;
  body: string[];
}

export interface TableData {
  columns: string[];
  rows: string[][];
}

export interface AgendaItem {
  time: string;
  topic: string;
  owner: string;
}

export interface ActionItem {
  task: string;
  owner: string;
  due: string;
}

export interface TimelinePhase {
  phase: string;
  window: string;
  detail: string;
}

export interface AssetDraft {
  kind: AssetKind;
  title: string;
  blurb: string;
  slides?: Slide[];
  sections?: DocSection[];
  table?: TableData;
  agenda?: AgendaItem[];
  actions?: ActionItem[];
  timeline?: TimelinePhase[];
}

export type RenderFormat = "md" | "pdf" | "pptx" | "xlsx";
