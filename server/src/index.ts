import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import JSZip from "jszip";
import { groqJson, hasGroqKey } from "./groq.js";
import { PLAN_SYSTEM, DRAFT_SYSTEM, CLARIFY_SYSTEM } from "./prompts.js";
import { qualityErrors, validateDraftQuality } from "./quality.js";
import { renderDraft } from "./render.js";
import {
  assetDraftSchema, draftRequestSchema, generateRequestSchema, packageRequestSchema,
  renderRequestSchema, requestPayloadSchema, validationDetails,
} from "./schemas.js";
import { buildWorkspaceRequest } from "./workspace.js";
import type {
  AssetDraft, AssetKind, AssetPlan, ClarifyQuestion, ClarifyResult, PackageBrief,
  PackagePlan, QualityIssue, WorkspaceContext,
} from "./types.js";

const PORT = Number(process.env.PORT) || 8787;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_TOKENS_CLARIFY = 900;
const MAX_TOKENS_PLAN = 1600;
const MAX_TOKENS_DRAFT = 3600;
const DRAFT_PACE_MS = 18000;
const VALID_KINDS = new Set<AssetKind>(["deck", "document", "sheet", "agenda", "actions", "timeline"]);
const OPEN = (detail: string) => `Needs your input: ${detail}`;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item, maxLength)).filter(Boolean).slice(0, maxItems) : [];
}

function invalid(res: express.Response, error: { issues: unknown[] }): void {
  res.status(400).json({ error: "Invalid request", details: validationDetails(error as never) });
}

function withOpenInputs(request: string, openInputs: string[] = []): string {
  if (!openInputs.length) return request;
  return `${request.trim()}\n\nOpen inputs:\n${openInputs.map((input) => `- ${input}`).join("\n")}`;
}

function coerceClarify(raw: unknown): ClarifyResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (obj.mode === "ready") return { mode: "ready", reply: "", questions: [] };
  if (obj.mode !== "clarify" || !Array.isArray(obj.questions)) throw new Error("Werk could not form safe clarification questions. Please try again.");
  const questions: ClarifyQuestion[] = obj.questions.map((item) => {
    const question = (item ?? {}) as Record<string, unknown>;
    return {
      key: asString(question.key, 30).replace(/\s+/g, "-").toLowerCase() || "detail",
      question: asString(question.question, 200),
      placeholder: asString(question.placeholder, 120) || undefined,
      required: Boolean(question.required),
    };
  }).filter((question) => question.question).slice(0, 4);
  if (!questions.length) throw new Error("Werk could not form safe clarification questions. Please try again.");
  return { mode: "clarify", reply: asString(obj.reply, 240), questions };
}

function coercePlan(raw: unknown): PackagePlan {
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
      evidenceIds: [] as string[],
      dependencies: textList(asset.dependencies, 8, 180),
    };
  });
  const assets: AssetPlan[] = proposedAssets.filter((asset): asset is AssetPlan => asset !== null).slice(0, 4).map((asset, index) => ({ ...asset, id: `a${index + 1}` }));
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
      return { heading: asString(section.heading, 220), body: textList(section.body, 3, 1400) };
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

async function generateDeepDraft(request: string, asset: AssetPlan, brief: PackageBrief, openInputs: string[], revisionInstruction?: string, previousDraft?: AssetDraft, onStage?: (stage: "verifying" | "revising") => void): Promise<AssetDraft> {
  const revision = (previousDraft?.metadata?.revision ?? 0) + 1;
  const assess = (raw: unknown): { draft?: AssetDraft; issues: QualityIssue[] } => {
    try { const draft = coerceDraft(raw, asset.kind, asset.title); return { draft, issues: validateDraftQuality(draft) }; }
    catch { return { issues: [{ code: "malformed-draft", message: "Return valid non-empty fields in the required JSON structure.", severity: "error" }] }; }
  };
  let candidate = assess(await groqJson(DRAFT_SYSTEM, draftPrompt(request, asset, brief, openInputs, revisionInstruction, previousDraft), MAX_TOKENS_DRAFT));
  if (qualityErrors(candidate.issues).length) {
    onStage?.("revising");
    candidate = assess(await groqJson(DRAFT_SYSTEM, draftPrompt(request, asset, brief, openInputs, revisionInstruction, previousDraft, candidate.issues), MAX_TOKENS_DRAFT));
  }
  onStage?.("verifying");
  const failures = qualityErrors(candidate.issues);
  if (!candidate.draft || failures.length) throw new Error(`The generated ${asset.kind} did not meet Werk’s safety standard: ${failures.map((issue) => issue.message).join(" ")}`);
  candidate.draft.metadata = { evidenceIds: asset.evidenceIds, assumptions: [], gaps: [...new Set([...brief.openInputs, ...openInputs])], quality: candidate.issues, revision };
  return candidate.draft;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, groq: hasGroqKey() }));

app.post("/api/clarify", async (req, res) => {
  const parsed = requestPayloadSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  try {
    const request = withOpenInputs(parsed.data.request, parsed.data.openInputs);
    const raw = await groqJson(CLARIFY_SYSTEM, buildWorkspaceRequest(parsed.data.workspaceContext, request), MAX_TOKENS_CLARIFY);
    res.json(coerceClarify(raw));
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "Clarification failed" }); }
});

app.post("/api/plan", async (req, res) => {
  const parsed = requestPayloadSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  try {
    const request = withOpenInputs(parsed.data.request, parsed.data.openInputs);
    const raw = await groqJson(PLAN_SYSTEM, buildWorkspaceRequest(parsed.data.workspaceContext, request), MAX_TOKENS_PLAN);
    const plan = coercePlan(raw);
    plan.brief.openInputs = [...new Set([...plan.brief.openInputs, ...(parsed.data.openInputs ?? [])])];
    res.json(plan);
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "Planning failed" }); }
});

app.post("/api/draft", async (req, res) => {
  const parsed = draftRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  if (!parsed.data.assetPlan || !parsed.data.brief) return res.status(400).json({ error: "A confirmed package brief and output plan are required." });
  try {
    const request = buildWorkspaceRequest(parsed.data.workspaceContext, withOpenInputs(parsed.data.request, parsed.data.openInputs));
    res.json(await generateDeepDraft(request, parsed.data.assetPlan, parsed.data.brief, parsed.data.openInputs ?? [], parsed.data.revisionInstruction, parsed.data.previousDraft));
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "Drafting failed" }); }
});

app.post("/api/render", async (req, res) => {
  const parsed = renderRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  try {
    const result = await renderDraft(parsed.data.draft, parsed.data.format);
    const safeTitle = parsed.data.draft.title.replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "output";
    res.setHeader("Content-Type", result.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${result.ext}"`);
    res.send(result.bytes);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Render failed" }); }
});

app.post("/api/package", async (req, res) => {
  const parsed = packageRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  try {
    const zip = new JSZip();
    const index: string[] = [];
    const gaps = new Set<string>();
    for (const [indexNumber, item] of parsed.data.items.entries()) {
      const result = await renderDraft(item.draft, item.format);
      const safe = item.draft.title.replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "output";
      const name = `${String(indexNumber + 1).padStart(2, "0")} ${safe}.${result.ext}`;
      zip.file(name, result.bytes); index.push(`- ${name}`);
      item.draft.metadata?.gaps.forEach((gap) => gaps.add(gap));
    }
    const notes = gaps.size ? `\n\n## Details to confirm\n\n${[...gaps].map((gap) => `- ${gap}`).join("\n")}\n\nThis package is a draft until these details are confirmed.` : "";
    zip.file("00 INDEX.md", `# ${parsed.data.packageName}\n\n${parsed.data.items.length} outputs assembled by Werk.\n\n${index.join("\n")}${notes}\n`);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const safeName = parsed.data.packageName.replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "package";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);
    res.send(bytes);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Package failed" }); }
});

app.post("/api/generate", async (req, res) => {
  const parsed = generateRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });

  const payload = parsed.data;
  const plan = payload.plan;
  if (!plan) return res.status(400).json({ error: "Review and confirm the suggested outputs before creating drafts." });
  const request = buildWorkspaceRequest(payload.workspaceContext, withOpenInputs(payload.request, payload.openInputs));
  const jobId = crypto.randomUUID(); let sequence = 0;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders?.();
  const send = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify({ ...event, jobId, sequence: ++sequence })}\n\n`);
  try {
    send({ type: "job-started" }); send({ type: "plan", plan });
    plan.assets.forEach((asset) => send({ type: "asset-status", id: asset.id, status: "queued" }));
    for (const [index, asset] of plan.assets.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, DRAFT_PACE_MS));
      try {
        send({ type: "asset-status", id: asset.id, status: "drafting" });
        const draft = await generateDeepDraft(request, asset, plan.brief, payload.openInputs ?? [], undefined, undefined, (stage) => send({ type: "asset-status", id: asset.id, status: stage }));
        const warnings = draft.metadata?.quality.filter((issue) => issue.severity === "warning") ?? [];
        if (warnings.length) send({ type: "quality-warning", id: asset.id, issues: warnings });
        send({ type: "draft", id: asset.id, draft });
      } catch (error) { send({ type: "draft-error", id: asset.id, message: error instanceof Error ? error.message : "Drafting failed" }); }
    }
    send({ type: "done" }); res.end();
  } catch (error) { send({ type: "error", message: error instanceof Error ? error.message : "Generation failed" }); res.end(); }
});

const clientDist = path.resolve(__dirname, "../../dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html"), (error) => { if (error) res.status(204).end(); }));
app.listen(PORT, () => console.log(`\n  werk API on http://localhost:${PORT}  (groq: ${hasGroqKey() ? "on" : "off"})\n`));
