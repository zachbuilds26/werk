import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import JSZip from "jszip";
import { hasGroqKey, groqJson } from "./groq.js";
import { createA2ARouter } from "./a2a.js";
import { AGENT_CARD_PATH, createAgentCardRouter } from "./agent-card.js";
import { createMarketplaceRouter, PROVIDER_PATH } from "./marketplace.js";
import { CLARIFY_SYSTEM } from "./prompts.js";
import {
  draftRequestSchema, generateRequestSchema, packageRequestSchema, renderRequestSchema,
  requestPayloadSchema, validationDetails,
} from "./schemas.js";
import { buildWorkspaceRequest } from "./workspace.js";
import { createDraft, createPlan, withOpenInputs } from "./workflows.js";
import type { ClarifyQuestion, ClarifyResult } from "./types.js";
import { createWerkPaymentIntegration } from "./okx-payment.js";
import { createRateLimiter, isA2APath, positiveInteger } from "./rate-limit.js";
import { startKeepAlive } from "./keepalive.js";

const PORT = Number(process.env.PORT) || 8787;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_TOKENS_CLARIFY = 900;
const DRAFT_PACE_MS = 18000;

const app = express();
const werkPayment = createWerkPaymentIntegration();
// Only publish payment details a buyer can actually pay to. When payment is
// switched on but incomplete the listing would otherwise advertise a real
// price alongside the zero address, and a buyer paying that loses the funds.
const marketplacePayment = werkPayment.health.ready ? werkPayment.listing : null;

// Model and render work is metered per caller. A2A and the marketplace are the
// agent-facing surfaces, so they also accept cross-origin browser clients.
const apiLimiter = createRateLimiter({
  max: positiveInteger(process.env.API_RATE_LIMIT_MAX, 40),
  windowMs: positiveInteger(process.env.API_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
  maxConcurrent: positiveInteger(process.env.API_MAX_CONCURRENT, 4),
});
const agentLimiter = createRateLimiter({
  max: positiveInteger(process.env.AGENT_RATE_LIMIT_MAX, 30),
  windowMs: positiveInteger(process.env.AGENT_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
  maxConcurrent: positiveInteger(process.env.AGENT_MAX_CONCURRENT, 2),
});

// Only the request-shaped routes cost anything. Reads (task status, artifact
// downloads) stay unmetered so a long-running stream cannot starve a caller
// collecting the deliverables it already paid for.
const postOnly = (limiter: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => (req.method === "POST" ? limiter(req, res, next) : next());

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// Health has to answer for the platform health check and the keepalive ping, so
// it is registered before any limiter and stays free.
app.get("/api/health", (_req, res) => res.json({ ok: true, groq: hasGroqKey(), payment: werkPayment.health }));

// The A2A routes do not share a mount prefix, so the agent middleware is
// selected by path shape (see isA2APath). Passing it to a bare app.use() would
// run it for every request, which would put the agent concurrency cap and a
// wildcard CORS header on /api and the static site too.
const agentCors = cors();
const meterAgent = postOnly(agentLimiter);
const agentGate: express.RequestHandler = (req, res, next) => {
  if (!isA2APath(req.path)) return next();
  agentCors(req, res, (error?: unknown) => (error ? next(error) : meterAgent(req, res, next)));
};

// A2A settles through the marketplace task escrow rather than an x402 challenge
// on this endpoint, so it stays outside the payment middleware on purpose. It is
// rate limited instead, because it runs the full model pipeline.
// Agent discovery. Registered before the SPA catch-all, which would otherwise
// answer the well-known path with index.html and a 200. Unmetered and
// cross-origin readable, because a client that cannot read the card cannot
// reach the agent at all.
app.get(AGENT_CARD_PATH, cors(), createAgentCardRouter());

app.use(agentGate, createA2ARouter());
app.use(werkPayment.middleware);
app.use(PROVIDER_PATH, createMarketplaceRouter(undefined, undefined, marketplacePayment));
app.use("/api", postOnly(apiLimiter));

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function invalid(res: express.Response, error: { issues: unknown[] }): void {
  res.status(400).json({ error: "Invalid request", details: validationDetails(error as never) });
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

app.post("/api/clarify", async (req, res) => {
  const parsed = requestPayloadSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  try {
    const request = withOpenInputs(parsed.data.request, parsed.data.openInputs);
    const raw = await groqJson(CLARIFY_SYSTEM, buildWorkspaceRequest(parsed.data.workspaceContext, request), MAX_TOKENS_CLARIFY);
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
    const plan = await createPlan({
      request: parsed.data.request,
      workspaceContext: parsed.data.workspaceContext,
      openInputs: parsed.data.openInputs,
    });
    res.json(plan);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Planning failed" });
  }
});

app.post("/api/draft", async (req, res) => {
  const parsed = draftRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  if (!parsed.data.assetPlan || !parsed.data.brief) return res.status(400).json({ error: "A confirmed package brief and output plan are required." });
  try {
    const draft = await createDraft({
      request: parsed.data.request,
      workspaceContext: parsed.data.workspaceContext,
      openInputs: parsed.data.openInputs,
      assetPlan: parsed.data.assetPlan,
      brief: parsed.data.brief,
      revisionInstruction: parsed.data.revisionInstruction,
      previousDraft: parsed.data.previousDraft,
    });
    res.json(draft);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Drafting failed" });
  }
});

app.post("/api/render", async (req, res) => {
  const parsed = renderRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  try {
    const { renderDraft } = await import("./render.js");
    const result = await renderDraft(parsed.data.draft, parsed.data.format);
    const safeTitle = parsed.data.draft.title.replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "output";
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
    const { renderDraft } = await import("./render.js");
    const zip = new JSZip();
    const index: string[] = [];
    const gaps = new Set<string>();
    for (const [indexNumber, item] of parsed.data.items.entries()) {
      const result = await renderDraft(item.draft, item.format);
      const safe = item.draft.title.replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "output";
      const name = `${String(indexNumber + 1).padStart(2, "0")} ${safe}.${result.ext}`;
      zip.file(name, result.bytes);
      index.push(`- ${name}`);
      item.draft.metadata?.gaps.forEach((gap) => gaps.add(gap));
    }
    const notes = gaps.size ? `\n\n## Details to confirm\n\n${[...gaps].map((gap) => `- ${gap}`).join("\n")}\n\nThis package is a draft until these details are confirmed.` : "";
    zip.file("00 INDEX.md", `# ${parsed.data.packageName}\n\n${parsed.data.items.length} outputs assembled by Werk.\n\n${index.join("\n")}${notes}\n`);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const safeName = parsed.data.packageName.replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "package";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);
    res.send(bytes);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Package failed" });
  }
});

app.post("/api/generate", async (req, res) => {
  const parsed = generateRequestSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });

  const payload = parsed.data;
  const plan = payload.plan;
  if (!plan) return res.status(400).json({ error: "Review and confirm the suggested outputs before creating drafts." });
  const jobId = crypto.randomUUID();
  let sequence = 0;
  // A client that navigates away must not leave the loop running: each
  // remaining asset would spend model quota writing to a closed socket.
  const controller = new AbortController();
  const stop = () => controller.abort();
  res.once("close", stop);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (event: Record<string, unknown>) => {
    if (controller.signal.aborted || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ ...event, jobId, sequence: ++sequence })}\n\n`);
  };
  const paused = (ms: number) => new Promise<void>((resolve) => {
    if (controller.signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", finish);
      resolve();
    }
    controller.signal.addEventListener("abort", finish, { once: true });
  });
  try {
    send({ type: "job-started" });
    send({ type: "plan", plan });
    plan.assets.forEach((asset) => send({ type: "asset-status", id: asset.id, status: "queued" }));
    for (const [index, asset] of plan.assets.entries()) {
      if (controller.signal.aborted) break;
      if (index > 0) await paused(DRAFT_PACE_MS);
      if (controller.signal.aborted) break;
      try {
        send({ type: "asset-status", id: asset.id, status: "drafting" });
        const draft = await createDraft({
          request: payload.request,
          workspaceContext: payload.workspaceContext,
          openInputs: payload.openInputs,
          assetPlan: asset,
          brief: plan.brief,
          signal: controller.signal,
          onStage: (stage) => send({ type: "asset-status", id: asset.id, status: stage }),
        });
        const warnings = draft.metadata?.quality.filter((issue) => issue.severity === "warning") ?? [];
        if (warnings.length) send({ type: "quality-warning", id: asset.id, issues: warnings });
        send({ type: "draft", id: asset.id, draft });
      } catch (error) {
        if (controller.signal.aborted) break;
        send({ type: "draft-error", id: asset.id, message: error instanceof Error ? error.message : "Drafting failed" });
      }
    }
    send({ type: "done" });
    res.end();
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : "Generation failed" });
    res.end();
  } finally {
    res.off("close", stop);
  }
});

const clientDist = path.resolve(__dirname, "../../dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html"), (error) => {
  if (error) res.status(204).end();
}));
app.listen(PORT, () => {
  const keepAlive = startKeepAlive();
  const warm = keepAlive.enabled ? "on" : "off";
  console.log(`\n  werk API on http://localhost:${PORT}  (groq: ${hasGroqKey() ? "on" : "off"}, keepalive: ${warm})\n`);
});
