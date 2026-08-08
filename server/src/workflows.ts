import { groqJson } from "./groq.js";
import { DRAFT_SYSTEM, PLAN_SYSTEM } from "./prompts.js";
import { qualityErrors, validateDraftQuality } from "./quality.js";
import { MAX_PLAN_ASSETS, assetDraftSchema } from "./schemas.js";
import { buildWorkspaceRequest } from "./workspace.js";
import type {
  AssetDraft, AssetKind, AssetPlan, PackageBrief, PackagePlan, QualityIssue, WorkspaceContext,
} from "./types.js";

const MAX_TOKENS_PLAN = 1600;
const MAX_TOKENS_DRAFT = 6500;
const VALID_KINDS = new Set<AssetKind>(["deck", "document", "sheet", "agenda", "actions", "timeline"]);
const OPEN = (detail: string) => `Needs your input: ${detail}`;

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item, maxLength)).filter(Boolean).slice(0, maxItems) : [];
}

export function withOpenInputs(request: string, openInputs: string[] = []): string {
  if (!openInputs.length) return request;
  return `${request.trim()}\n\nOpen inputs:\n${openInputs.map((input) => `- ${input}`).join("\n")}`;
}

export function coercePlan(raw: unknown): PackagePlan {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawBrief = (obj.brief ?? {}) as Record<string, unknown>;
  const openInputs = textList(rawBrief.openInputs, 12, 280);
  const brief: PackageBrief = {
    objective: asString(rawBrief.objective, 320) || OPEN("objective"),
    audience: asString(rawBrief.audience, 180) || OPEN("audience"),
    decision: asString(rawBrief.decision, 320) || OPEN("desired outcome"),
    timing: asString(rawBrief.timing, 180) || OPEN("timing"),
    knownDetails: textList(rawBrief.knownDetails, 16, 280),
    openInputs,
    sharedTerms: textList(rawBrief.sharedTerms, 12, 100),
    consistencyRules: textList(rawBrief.consistencyRules, 12, 180),
  };
  const proposedAssets = (Array.isArray(obj.assets) ? obj.assets : []).map((item): AssetPlan | null => {
    const asset = (item ?? {}) as Record<string, unknown>;
    const kind = asString(asset.kind, 20) as AssetKind;
    if (!VALID_KINDS.has(kind)) return null;
    const title = asString(asset.title, 180);
    if (!title) return null;
    return {
      id: "",
      kind,
      title,
      summary: asString(asset.summary, 300) || "A focused work output with open inputs kept visible.",
      purpose: asString(asset.purpose, 360) || "Help the person move this work forward.",
      audience: asString(asset.audience, 180) || brief.audience,
      decision: asString(asset.decision, 320) || brief.decision,
      requiredAnalysis: textList(asset.requiredAnalysis, 8, 280).length ? textList(asset.requiredAnalysis, 8, 280) : ["Use supplied details and keep open inputs visible."],
      acceptanceCriteria: textList(asset.acceptanceCriteria, 8, 280).length ? textList(asset.acceptanceCriteria, 8, 280) : ["Useful, clear, and free of invented facts."],
      evidenceIds: [],
      dependencies: textList(asset.dependencies, 8, 180),
    };
  });
  const assets: AssetPlan[] = proposedAssets.filter((asset): asset is AssetPlan => asset !== null).slice(0, MAX_PLAN_ASSETS).map((asset, index) => ({ ...asset, id: `a${index + 1}` }));
  if (!assets.length) throw new Error("Werk could not suggest a useful set of outputs. Please make the request more specific.");
  return {
    packageName: asString(obj.packageName, 80) || "Suggested work",
    packageTitle: asString(obj.packageTitle, 180) || "Your work plan",
    reply: asString(obj.reply, 280) || "Review the suggested outputs before creating drafts.",
    brief,
    assets,
  };
}

function coerceDraft(raw: unknown, kind: AssetKind, title: string): AssetDraft {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const draft: AssetDraft = { kind, title, blurb: asString(obj.blurb, 700) };
  switch (kind) {
    case "deck": draft.slides = (Array.isArray(obj.slides) ? obj.slides : []).map((item) => {
      const slide = (item ?? {}) as Record<string, unknown>;
      return { eyebrow: asString(slide.eyebrow, 80), title: asString(slide.title, 220), bullets: textList(slide.bullets, 6, 500) };
    }).filter((slide) => slide.title || slide.bullets.length).slice(0, 18); break;
    case "document": draft.sections = (Array.isArray(obj.sections) ? obj.sections : []).map((item) => {
      const section = (item ?? {}) as Record<string, unknown>;
      const heading = asString(section.heading, 220) || asString(section.title, 220);
      const body = textList(section.body, 6, 1400);
      if (!body.length) {
        const content = asString(section.content ?? section.text, 4000);
        if (content) body.push(...content.split(/\n{2,}|\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean).slice(0, 6));
      }
      return { heading, body };
    }).filter((section) => section.heading || section.body.length).slice(0, 10); break;
    case "sheet": {
      const table = (obj.table ?? {}) as Record<string, unknown>;
      const columns = textList(table.columns, 10, 120);
      const rows = Array.isArray(table.rows) ? table.rows.map((row) => Array.isArray(row) ? row.map((cell) => asString(cell, 180)) : []).slice(0, 24) : [];
      if (columns.length) draft.table = { columns, rows };
      break;
    }
    case "agenda": draft.agenda = (Array.isArray(obj.agenda) ? obj.agenda : []).map((item) => {
      const agenda = (item ?? {}) as Record<string, unknown>;
      return { time: asString(agenda.time, 80), topic: asString(agenda.topic, 240), owner: asString(agenda.owner, 140) };
    }).slice(0, 12); break;
    case "actions": draft.actions = (Array.isArray(obj.actions) ? obj.actions : []).map((item) => {
      const action = (item ?? {}) as Record<string, unknown>;
      return { task: asString(action.task, 300), owner: asString(action.owner, 140), due: asString(action.due, 120) };
    }).slice(0, 16); break;
    case "timeline": draft.timeline = (Array.isArray(obj.timeline) ? obj.timeline : []).map((item) => {
      const phase = (item ?? {}) as Record<string, unknown>;
      return { phase: asString(phase.phase, 160), window: asString(phase.window, 120), detail: asString(phase.detail, 900) };
    }).slice(0, 10); break;
  }
  const parsed = assetDraftSchema.safeParse(draft);
  if (!parsed.success) throw new Error("The model returned a malformed draft.");
  return parsed.data;
}

function draftPrompt(request: string, asset: AssetPlan, brief: PackageBrief, openInputs: string[], revisionInstruction?: string, previousDraft?: AssetDraft, qualityIssues: QualityIssue[] = []): string {
  const revision = revisionInstruction ? `\nRevision instruction: ${revisionInstruction}` : "";
  const previous = previousDraft ? `\nPrevious draft (an artifact, not evidence): ${JSON.stringify(previousDraft)}` : "";
  const retry = qualityIssues.length ? `\nQUALITY GATE: Fix these defects without inventing data: ${qualityIssues.map((issue) => issue.message).join(" ")}` : "";
  return [
    `Kind: ${asset.kind}`, `Title: ${asset.title}`, `Purpose: ${asset.purpose}`,
    `Audience: ${asset.audience}`, `Desired outcome: ${asset.decision}`,
    `Approved brief: ${JSON.stringify(brief)}`,
    `Open inputs: ${JSON.stringify(openInputs)}`,
    `Required analysis: ${asset.requiredAnalysis.join(" | ")}`,
    `Request: ${request}`,
  ].join("\n") + revision + previous + retry;
}

export type PlanInput = {
  request: string;
  workspaceContext: WorkspaceContext;
  openInputs?: string[];
  signal?: AbortSignal;
};

export async function createPlan({ request, workspaceContext, openInputs = [], signal }: PlanInput): Promise<PackagePlan> {
  const source = withOpenInputs(request, openInputs);
  const raw = await groqJson(PLAN_SYSTEM, buildWorkspaceRequest(workspaceContext, source), MAX_TOKENS_PLAN, signal);
  const plan = coercePlan(raw);
  plan.brief.openInputs = [...new Set([...plan.brief.openInputs, ...openInputs])];
  return plan;
}

export type DraftInput = PlanInput & {
  assetPlan: AssetPlan;
  brief: PackageBrief;
  revisionInstruction?: string;
  previousDraft?: AssetDraft;
  onStage?: (stage: "verifying" | "revising") => void;
};

export async function createDraft({ request, workspaceContext, assetPlan, brief, openInputs = [], revisionInstruction, previousDraft, onStage, signal }: DraftInput): Promise<AssetDraft> {
  const revision = (previousDraft?.metadata?.revision ?? 0) + 1;
  const assess = (raw: unknown): { draft?: AssetDraft; issues: QualityIssue[] } => {
    try {
      const draft = coerceDraft(raw, assetPlan.kind, assetPlan.title);
      return { draft, issues: validateDraftQuality(draft) };
    } catch {
      return { issues: [{ code: "malformed-draft", message: "Return valid non-empty fields in the required JSON structure.", severity: "error" }] };
    }
  };
  const source = buildWorkspaceRequest(workspaceContext, withOpenInputs(request, openInputs));
  let candidate = assess(await groqJson(DRAFT_SYSTEM, draftPrompt(source, assetPlan, brief, openInputs, revisionInstruction, previousDraft), MAX_TOKENS_DRAFT, signal));
  if (qualityErrors(candidate.issues).length) {
    onStage?.("revising");
    candidate = assess(await groqJson(DRAFT_SYSTEM, draftPrompt(source, assetPlan, brief, openInputs, revisionInstruction, previousDraft, candidate.issues), MAX_TOKENS_DRAFT, signal));
  }
  onStage?.("verifying");
  const failures = qualityErrors(candidate.issues);
  if (!candidate.draft || failures.length) throw new Error(`The generated ${assetPlan.kind} did not meet Werk’s safety standard: ${failures.map((issue) => issue.message).join(" ")}`);
  candidate.draft.metadata = { evidenceIds: assetPlan.evidenceIds, assumptions: [], gaps: [...new Set([...brief.openInputs, ...openInputs])], quality: candidate.issues, revision };
  return candidate.draft;
}
