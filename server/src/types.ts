// Shared domain shapes for the WERK API. The model may propose a package, but
// user-provided context and open inputs remain visible through every draft.

export type AssetKind = "deck" | "document" | "sheet" | "agenda" | "actions" | "timeline";

export const ASSET_KINDS: readonly AssetKind[] = [
  "deck", "document", "sheet", "agenda", "actions", "timeline",
];

export type RenderFormat = "md" | "pdf" | "pptx" | "xlsx";
export type EvidenceSource = "user" | "workspace" | "clarification";

export interface EvidenceItem {
  id: string;
  label: string;
  value: string;
  source: EvidenceSource;
  sourceDetail: string;
}

export interface ContextPack {
  request: string;
  workspace: WorkspaceContext;
  evidence: EvidenceItem[];
  gaps: string[];
}

export interface AssetPlan {
  id: string;
  kind: AssetKind;
  title: string;
  summary: string;
  purpose: string;
  audience: string;
  decision: string;
  requiredAnalysis: string[];
  acceptanceCriteria: string[];
  evidenceIds: string[];
  dependencies: string[];
}

export type PlanAsset = AssetPlan;

export interface PackageBrief {
  objective: string;
  audience: string;
  decision: string;
  timing: string;
  knownDetails: string[];
  openInputs: string[];
  sharedTerms: string[];
  consistencyRules: string[];
}

export interface PackagePlan {
  packageName: string;
  packageTitle: string;
  reply: string;
  brief: PackageBrief;
  assets: AssetPlan[];
}

export interface ClarifyQuestion {
  key: string;
  question: string;
  placeholder?: string;
  required?: boolean;
}

export interface ClarifyResult {
  mode: "clarify" | "ready";
  reply: string;
  questions: ClarifyQuestion[];
}

export interface WorkspaceContext {
  organizationName: string;
  organizationDescription: string;
  workspacePurpose: string;
  defaultAudience?: string;
  toneAndConstraints?: string;
  additionalContext?: string;
}

export interface WorkspaceRequestPayload {
  request: string;
  workspaceContext: WorkspaceContext;
  openInputs?: string[];
}

export interface DraftRequestPayload extends WorkspaceRequestPayload {
  kind: AssetKind;
  title: string;
  assetPlan?: AssetPlan;
  brief?: PackageBrief;
  revisionInstruction?: string;
  previousDraft?: AssetDraft;
}

export interface Slide { eyebrow: string; title: string; bullets: string[] }
export interface DocSection { heading: string; body: string[] }
export interface TableData { columns: string[]; rows: string[][] }
export interface AgendaItem { time: string; topic: string; owner: string }
export interface ActionItem { task: string; owner: string; due: string }
export interface TimelinePhase { phase: string; window: string; detail: string }

export interface QualityIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
  path?: string;
}

export interface DraftMetadata {
  evidenceIds: string[];
  assumptions: string[];
  gaps: string[];
  quality: QualityIssue[];
  revision: number;
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
  metadata?: DraftMetadata;
}

export type GenerateEvent =
  | { type: "job-started"; jobId: string; sequence: number }
  | { type: "plan"; jobId: string; sequence: number; plan: PackagePlan }
  | { type: "asset-status"; jobId: string; sequence: number; id: string; status: "queued" | "drafting" | "verifying" | "revising" }
  | { type: "quality-warning"; jobId: string; sequence: number; id: string; issues: QualityIssue[] }
  | { type: "draft"; jobId: string; sequence: number; id: string; draft: AssetDraft }
  | { type: "draft-error"; jobId: string; sequence: number; id: string; message: string }
  | { type: "done"; jobId: string; sequence: number }
  | { type: "error"; jobId: string; sequence: number; message: string };
