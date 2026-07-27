// WERK API. The server owns request validation, generation quality gates, and
// render exports. The browser only receives drafts that meet the same domain
// rules used by the download routes.

import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import JSZip from "jszip";
import { groqJson, hasGroqKey } from "./groq.js";
import { ASSET_SPECS } from "./asset-specs.js";
import { PLAN_SYSTEM, DRAFT_SYSTEM, CLARIFY_SYSTEM } from "./prompts.js";
import { qualityErrors, validateDraftQuality } from "./quality.js";
import { renderDraft } from "./render.js";
import {
  assetDraftSchema,
  draftRequestSchema,
  packageRequestSchema,
  renderRequestSchema,
  requestPayloadSchema,
  validationDetails,
} from "./schemas.js";
import {
  buildWorkspaceRequest,
  stripWorkspaceContextBlock,
} from "./workspace.js";
import type {
  AssetDraft,
  AssetKind,
  AssetPlan,
  ClarifyQuestion,
  ClarifyResult,
  PackageBrief,
  PackagePlan,
  QualityIssue,
  RenderFormat,
  WorkspaceContext,
} from "./types.js";

const PORT = Number(process.env.PORT) || 8787;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_TOKENS_CLARIFY = 1000;
const MAX_TOKENS_PLAN = 1800;
const MAX_TOKENS_DRAFT = 5200;
const DRAFT_PACE_MS = 18000;
const REQUEST_MAX_CHARS = 6000;
const VALID_KINDS = new Set<AssetKind>(["deck", "document", "sheet", "agenda", "actions", "timeline"]);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item, maxLength)).filter(Boolean).slice(0, maxItems)
    : [];
}

function requestSummary(request: string): string {
  const latest = request.match(/New user message:\s*([\s\S]*)/i)?.[1]?.trim() ?? request.trim();
  return latest.split("\n")[0].trim().slice(0, 120) || "New package";
}

function invalid(res: express.Response, error: { issues: unknown[] }): void {
  res.status(400).json({ error: "Invalid request", details: validationDetails(error as never) });
}

function coerceClarify(raw: unknown): ClarifyResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const mode: ClarifyResult["mode"] = obj.mode === "clarify" ? "clarify" : "ready";
  const questions: ClarifyQuestion[] = mode === "clarify" && Array.isArray(obj.questions)
    ? obj.questions.map((item) => {
      const question = (item ?? {}) as Record<string, unknown>;
      return {
        key: asString(question.key, 30).replace(/\s+/g, "-").toLowerCase() || "detail",
        question: asString(question.question, 200),
        placeholder: asString(question.placeholder, 120) || undefined,
        required: Boolean(question.required),
      };
    }).filter((question) => question.question).slice(0, 4)
    : [];

  if (mode === "clarify" && questions.length === 0) return { mode: "ready", reply: "", questions: [] };
  return { mode, reply: asString(obj.reply, 240), questions };
}

function coercePlan(raw: unknown, request: string, workspace: WorkspaceContext): PackagePlan {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawBrief = (obj.brief ?? {}) as Record<string, unknown>;
  const objective = asString(rawBrief.objective, 320) || requestSummary(request);
  const defaultAudience = workspace.defaultAudience || "Leadership team";
  const brief: PackageBrief = {
    objective,
    audience: asString(rawBrief.audience, 180) || defaultAudience,
    decision: asString(rawBrief.decision, 320) || "Confirm the recommended direction, owners, and next steps.",
    timing: asString(rawBrief.timing, 180) || "Timing to be confirmed with the request owner.",
    sharedTerms: textList(rawBrief.sharedTerms, 12, 100),
    consistencyRules: textList(rawBrief.consistencyRules, 12, 180),
  };

  const assets: AssetPlan[] = (Array.isArray(obj.assets) ? obj.assets : [])
    .map((item) => {
      const asset = (item ?? {}) as Record<string, unknown>;
      const kind = asString(asset.kind, 20) as AssetKind;
      if (!VALID_KINDS.has(kind)) return null;
      const summary = asString(asset.summary, 300) || `Decision-ready ${kind} for ${objective}.`;
      return {
        id: "",
        kind,
        title: asString(asset.title, 180) || `${workspace.organizationName} ${kind}`,
        summary,
        purpose: asString(asset.purpose, 360) || summary,
        audience: asString(asset.audience, 180) || brief.audience,
        decision: asString(asset.decision, 320) || brief.decision,
        requiredAnalysis: textList(asset.requiredAnalysis, 8, 280).length
          ? textList(asset.requiredAnalysis, 8, 280)
          : ["Use the request evidence, explain its implication, and make the next decision clear."],
        acceptanceCriteria: textList(asset.acceptanceCriteria, 8, 280).length
          ? textList(asset.acceptanceCriteria, 8, 280)
          : [ASSET_SPECS[kind].promptRequirement],
        evidenceIds: textList(asset.evidenceIds, 24, 80),
        dependencies: textList(asset.dependencies, 8, 180),
      };
    })
    .filter((asset): asset is AssetPlan => asset !== null)
    .slice(0, 6)
    .map((asset, index) => ({ ...asset, id: `a${index + 1}` }));

  return {
    packageName: asString(obj.packageName, 80) || "Package",
    packageTitle: asString(obj.packageTitle, 180) || requestSummary(request),
    reply: asString(obj.reply, 280) || "I’m assembling the package now.",
    brief,
    assets,
  };
}

function coerceDraft(raw: unknown, kind: AssetKind, title: string): AssetDraft {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const draft: AssetDraft = {
    kind,
    title,
    blurb: asString(obj.blurb, 700),
  };

  switch (kind) {
    case "deck":
      draft.slides = (Array.isArray(obj.slides) ? obj.slides : []).map((item) => {
        const slide = (item ?? {}) as Record<string, unknown>;
        return {
          eyebrow: asString(slide.eyebrow, 80),
          title: asString(slide.title, 220),
          bullets: textList(slide.bullets, 6, 500),
        };
      }).filter((slide) => slide.title || slide.bullets.length).slice(0, 18);
      break;
    case "document":
      draft.sections = (Array.isArray(obj.sections) ? obj.sections : []).map((item) => {
        const section = (item ?? {}) as Record<string, unknown>;
        return { heading: asString(section.heading, 220), body: textList(section.body, 3, 1400) };
      }).filter((section) => section.heading || section.body.length).slice(0, 10);
      break;
    case "sheet": {
      const table = (obj.table ?? {}) as Record<string, unknown>;
      const columns = textList(table.columns, 10, 120);
      const rows = Array.isArray(table.rows)
        ? table.rows.map((row) => Array.isArray(row) ? row.map((cell) => asString(cell, 180)) : []).slice(0, 24)
        : [];
      if (columns.length) draft.table = { columns, rows };
      break;
    }
    case "agenda":
      draft.agenda = (Array.isArray(obj.agenda) ? obj.agenda : []).map((item) => {
        const agenda = (item ?? {}) as Record<string, unknown>;
        return { time: asString(agenda.time, 48), topic: asString(agenda.topic, 240), owner: asString(agenda.owner, 100) };
      }).slice(0, 12);
      break;
    case "actions":
      draft.actions = (Array.isArray(obj.actions) ? obj.actions : []).map((item) => {
        const action = (item ?? {}) as Record<string, unknown>;
        return { task: asString(action.task, 300), owner: asString(action.owner, 100), due: asString(action.due, 80) };
      }).slice(0, 16);
      break;
    case "timeline":
      draft.timeline = (Array.isArray(obj.timeline) ? obj.timeline : []).map((item) => {
        const phase = (item ?? {}) as Record<string, unknown>;
        return { phase: asString(phase.phase, 160), window: asString(phase.window, 100), detail: asString(phase.detail, 900) };
      }).slice(0, 10);
      break;
  }

  const parsed = assetDraftSchema.safeParse(draft);
  if (!parsed.success) throw new Error("The model returned a malformed draft.");
  return parsed.data;
}

function draftPrompt(
  request: string,
  asset: AssetPlan,
  revisionInstruction?: string,
  qualityIssues: QualityIssue[] = [],
): string {
  const retry = qualityIssues.length
    ? `\n\nQUALITY GATE: Regenerate the complete asset. Fix these defects: ${qualityIssues.map((issue) => issue.message).join(" ")}`
    : "";
  const revision = revisionInstruction ? `\nRevision instruction: ${revisionInstruction}` : "";
  return [
    `Kind: ${asset.kind}`,
    `Title: ${asset.title}`,
    `Asset purpose: ${asset.purpose}`,
    `Audience: ${asset.audience}`,
    `Decision or outcome: ${asset.decision}`,
    `Required analysis: ${asset.requiredAnalysis.join(" | ")}`,
    `Acceptance criteria: ${asset.acceptanceCriteria.join(" | ")}`,
    `Request: ${request}`,
  ].join("\n") + revision + retry;
}

async function generateDeepDraft(
  request: string,
  asset: AssetPlan,
  revisionInstruction?: string,
  previousDraft?: AssetDraft,
  onStage?: (stage: "verifying" | "revising") => void,
): Promise<AssetDraft> {
  const revision = (previousDraft?.metadata?.revision ?? 0) + 1;
  const assess = (raw: unknown): { draft?: AssetDraft; issues: QualityIssue[] } => {
    try {
      const draft = coerceDraft(raw, asset.kind, asset.title);
      return { draft, issues: validateDraftQuality(draft) };
    } catch {
      return {
        issues: [{
          code: "malformed-draft",
          message: "Return every required field with valid, non-empty content in the required JSON structure.",
          severity: "error",
        }],
      };
    }
  };

  let raw = await groqJson(DRAFT_SYSTEM, draftPrompt(request, asset, revisionInstruction), MAX_TOKENS_DRAFT);
  let candidate = assess(raw);

  if (qualityErrors(candidate.issues).length > 0) {
    onStage?.("verifying");
    onStage?.("revising");
    raw = await groqJson(DRAFT_SYSTEM, draftPrompt(request, asset, revisionInstruction, candidate.issues), MAX_TOKENS_DRAFT);
    candidate = assess(raw);
  }

  onStage?.("verifying");
  const failures = qualityErrors(candidate.issues);
  if (!candidate.draft || failures.length > 0) {
    throw new Error(`The generated ${asset.kind} did not meet Werk’s quality standard: ${failures.map((issue) => issue.message).join(" ")}`);
  }

  candidate.draft.metadata = {
    evidenceIds: asset.evidenceIds,
    assumptions: candidate.draft.blurb.includes("Figures are illustrative starting points")
      ? ["Figures are illustrative starting points; replace with your actuals."]
      : [],
    gaps: [],
    quality: candidate.issues,
    revision,
  };
  return candidate.draft;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, groq: hasGroqKey() });
});

app.post("/api/clarify", async (req, res) => {
  const parsed = requestPayloadSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  try {
    const request = parsed.data.request.slice(0, REQUEST_MAX_CHARS);
    const modelRequest = buildWorkspaceRequest(parsed.data.workspaceContext, request);
    const raw = await groqJson(CLARIFY_SYSTEM, modelRequest, MAX_TOKENS_CLARIFY);
    res.json(coerceClarify(raw));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Clarification failed" });
  }
});

app.post("/api/plan", async (req, res) => {
  const parsed = requestPayloadSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  try {
    const request = parsed.data.request.slice(0, REQUEST_MAX_CHARS);
    const modelRequest = buildWorkspaceRequest(parsed.data.workspaceContext, request);
    const raw = await groqJson(PLAN_SYSTEM, modelRequest, MAX_TOKENS_PLAN);
    res.json(coercePlan(raw, stripWorkspaceContextBlock(request), parsed.data.workspaceContext));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Planning failed" });
  }
});

app.post("/api/draft", async (req, res) => {
  const parsed = draftRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  try {
    const payload = parsed.data;
    const request = buildWorkspaceRequest(payload.workspaceContext, payload.request.slice(0, REQUEST_MAX_CHARS));
    const asset: AssetPlan = payload.assetPlan ?? {
      id: "single",
      kind: payload.kind,
      title: payload.title,
      summary: payload.title,
      purpose: payload.title,
      audience: payload.workspaceContext.defaultAudience || "Leadership team",
      decision: "Deliver a decision-ready asset.",
      requiredAnalysis: ["Use the request evidence and make the next action clear."],
      acceptanceCriteria: [ASSET_SPECS[payload.kind].promptRequirement],
      evidenceIds: [],
      dependencies: [],
    };
    res.json(await generateDeepDraft(request, asset, payload.revisionInstruction, payload.previousDraft));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Drafting failed" });
  }
});

app.post("/api/render", async (req, res) => {
  const parsed = renderRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  try {
    const result = await renderDraft(parsed.data.draft, parsed.data.format);
    const safeTitle = parsed.data.draft.title.replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "asset";
    res.setHeader("Content-Type", result.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${result.ext}"`);
    res.send(result.bytes);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Render failed" });
  }
});

app.post("/api/package", async (req, res) => {
  const parsed = packageRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  try {
    const zip = new JSZip();
    const index: string[] = [];
    for (const [indexNumber, item] of parsed.data.items.entries()) {
      const result = await renderDraft(item.draft, item.format);
      const safe = item.draft.title.replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "asset";
      const name = `${String(indexNumber + 1).padStart(2, "0")} ${safe}.${result.ext}`;
      zip.file(name, result.bytes);
      index.push(`- ${name}`);
    }
    const packageName = parsed.data.packageName;
    zip.file("00 INDEX.md", `# ${packageName}\n\n${parsed.data.items.length} assets assembled by WERK.\n\n${index.join("\n")}\n`);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const safeName = packageName.replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "package";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);
    res.send(bytes);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Package failed" });
  }
});

app.post("/api/generate", async (req, res) => {
  const parsed = requestPayloadSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });

  const payload = parsed.data;
  const request = payload.request.slice(0, REQUEST_MAX_CHARS);
  const visibleRequest = stripWorkspaceContextBlock(request);
  const modelRequest = buildWorkspaceRequest(payload.workspaceContext, request);
  const jobId = crypto.randomUUID();
  let sequence = 0;

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify({ ...event, jobId, sequence: ++sequence })}\n\n`);
  const fail = (message: string) => {
    send({ type: "error", message });
    res.end();
  };

  try {
    send({ type: "job-started" });
    const rawPlan = await groqJson(PLAN_SYSTEM, modelRequest, MAX_TOKENS_PLAN);
    const plan = coercePlan(rawPlan, visibleRequest, payload.workspaceContext);
    send({ type: "plan", plan });
    plan.assets.forEach((asset) => send({ type: "asset-status", id: asset.id, status: "queued" }));

    for (const [index, asset] of plan.assets.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, DRAFT_PACE_MS));
      try {
        send({ type: "asset-status", id: asset.id, status: "drafting" });
        const draft = await generateDeepDraft(modelRequest, asset, undefined, undefined, (stage) => {
          send({ type: "asset-status", id: asset.id, status: stage });
        });
        const warnings = draft.metadata?.quality.filter((issue) => issue.severity === "warning") ?? [];
        if (warnings.length) send({ type: "quality-warning", id: asset.id, issues: warnings });
        send({ type: "draft", id: asset.id, draft });
      } catch (error) {
        send({ type: "draft-error", id: asset.id, message: error instanceof Error ? error.message : "Drafting failed" });
      }
    }
    send({ type: "done" });
    res.end();
  } catch (error) {
    fail(error instanceof Error ? error.message : "Generation failed");
  }
});

const clientDist = path.resolve(__dirname, "../../dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (error) => {
    if (error) res.status(204).end();
  });
});

app.listen(PORT, () => {
  console.log(`\n  werk API on http://localhost:${PORT}  (groq: ${hasGroqKey() ? "on" : "off"})\n`);
});
