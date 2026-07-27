// WERK API — Express server on port 8787 (the Vite dev proxy target).
//
// Endpoints:
//   GET  /api/health        -> { ok, groq }
//   POST /api/clarify       { request } -> ClarifyResult (ask, or ready)
//   POST /api/plan          { request } -> PackagePlan
//   POST /api/draft         { kind, title, request } -> AssetDraft
//   POST /api/render        { draft, format } -> binary file (attachment)
//   POST /api/generate      { request } -> text/event-stream of plan + drafts
//
// The generate stream is the main path the workspace uses: one connection,
// the plan first, then each asset drafted in turn (gentler on the Groq free
// tier than fanning out six calls at once), then done.

import "dotenv/config";
import express from "express";
import cors from "cors";
import JSZip from "jszip";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { groqJson, hasGroqKey } from "./groq.js";
import { PLAN_SYSTEM, DRAFT_SYSTEM, CLARIFY_SYSTEM } from "./prompts.js";
import { renderDraft } from "./render.js";
import type {
  AssetDraft,
  AssetKind,
  ClarifyQuestion,
  ClarifyResult,
  PackagePlan,
  PlanAsset,
  RenderFormat,
} from "./types.js";

const PORT = Number(process.env.PORT) || 8787;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Output token limits per call. Drafts get enough room for complete working
// assets, then run sequentially so the Groq free tier is not hit in a burst.
const MAX_TOKENS_CLARIFY = 1000;
const MAX_TOKENS_PLAN = 1400;
const MAX_TOKENS_DRAFT = 5200;

// Pace between sequential drafts in /api/generate. The Groq free tier enforces
// a tight per-minute token limit, so a full 6-asset package must spread its
// drafts out; the 429 retry in groq.ts backstops any remaining overages.
const DRAFT_PACE_MS = 18000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ---------- validation ---------- */
const VALID_KINDS = new Set<AssetKind>([
  "deck",
  "document",
  "sheet",
  "agenda",
  "actions",
  "timeline",
]);

function asString(v: unknown, max = 400): string {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.slice(0, max);
}

/** Coerce a raw Groq plan object into a trusted PackagePlan, assigning ids. */
function coercePlan(raw: unknown, request: string): PackagePlan {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const assetsRaw = Array.isArray(obj.assets) ? obj.assets : [];
  const assets: PlanAsset[] = assetsRaw
    .map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const kind = asString(o.kind, 20) as AssetKind;
      if (!VALID_KINDS.has(kind)) return null;
      return {
        id: "",
        kind,
        title: asString(o.title, 120) || "Untitled",
        summary: asString(o.summary, 240),
      } as PlanAsset;
    })
    .filter((a): a is PlanAsset => a !== null)
    .slice(0, 6)
    .map((a, i) => ({ ...a, id: `a${i + 1}` }));

  const packageName = asString(obj.packageName, 60) || "Package";
  const packageTitle = asString(obj.packageTitle, 120) || request.slice(0, 60) || "Untitled";
  const reply = asString(obj.reply, 200) || "On it — assembling your package.";

  return { packageName, packageTitle, reply, assets };
}

/** Coerce a raw Groq draft into a trusted AssetDraft of the requested kind. */
function coerceDraft(raw: unknown, kind: AssetKind, title: string): AssetDraft {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const blurb = asString(obj.blurb, 320);
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => asString(x, 300)).filter(Boolean) : [];

  const draft: AssetDraft = { kind, title, blurb };

  switch (kind) {
    case "deck": {
      draft.slides = (Array.isArray(obj.slides) ? obj.slides : [])
        .map((s) => {
          const o = (s ?? {}) as Record<string, unknown>;
          return {
            eyebrow: asString(o.eyebrow, 60),
            title: asString(o.title, 160),
            bullets: strArr(o.bullets),
          };
        })
        .filter((s) => s.title || s.bullets.length)
        .slice(0, 20);
      break;
    }
    case "document": {
      draft.sections = (Array.isArray(obj.sections) ? obj.sections : [])
        .map((s) => {
          const o = (s ?? {}) as Record<string, unknown>;
          return { heading: asString(o.heading, 160), body: strArr(o.body) };
        })
        .filter((s) => s.heading || s.body.length)
        .slice(0, 20);
      break;
    }
    case "sheet": {
      const t = (obj.table ?? {}) as Record<string, unknown>;
      const columns = strArr(t.columns);
      const rows = Array.isArray(t.rows)
        ? (t.rows as unknown[])
            .map((r) => (Array.isArray(r) ? r.map((c) => asString(c, 120)) : []))
            .slice(0, 40)
        : [];
      if (columns.length) draft.table = { columns, rows };
      break;
    }
    case "agenda": {
      draft.agenda = (Array.isArray(obj.agenda) ? obj.agenda : [])
        .map((a) => {
          const o = (a ?? {}) as Record<string, unknown>;
          return {
            time: asString(o.time, 40),
            topic: asString(o.topic, 160),
            owner: asString(o.owner, 80),
          };
        })
        .slice(0, 20);
      break;
    }
    case "actions": {
      draft.actions = (Array.isArray(obj.actions) ? obj.actions : [])
        .map((a) => {
          const o = (a ?? {}) as Record<string, unknown>;
          return {
            task: asString(o.task, 200),
            owner: asString(o.owner, 80),
            due: asString(o.due, 40),
          };
        })
        .slice(0, 25);
      break;
    }
    case "timeline": {
      draft.timeline = (Array.isArray(obj.timeline) ? obj.timeline : [])
        .map((p) => {
          const o = (p ?? {}) as Record<string, unknown>;
          return {
            phase: asString(o.phase, 120),
            window: asString(o.window, 60),
            detail: asString(o.detail, 240),
          };
        })
        .slice(0, 20);
      break;
    }
  }

  return draft;
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function isDetailed(value: string, minWords: number): boolean {
  return wordCount(value) >= minWords;
}

/** Reject syntactically valid but skeletal model responses before they reach the UI. */
function draftDepthIssues(draft: AssetDraft): string[] {
  const issues: string[] = [];
  if (!isDetailed(draft.blurb, 12)) issues.push("a substantive summary");

  switch (draft.kind) {
    case "deck": {
      const slides = draft.slides ?? [];
      if (slides.length < 12) issues.push("at least 12 slides");
      if (slides.some((slide, index) => !slide.eyebrow || !isDetailed(slide.title, 3))) {
        issues.push("a complete section tag and claim headline on every slide");
      }
      if (slides.some((slide, index) => slide.bullets.length < (index === 0 ? 1 : 4))) {
        issues.push("the required detailed bullets on every slide");
      }
      break;
    }
    case "document": {
      const sections = draft.sections ?? [];
      if (sections.length < 6) issues.push("at least 6 report sections");
      if (sections.some((section) => !section.heading || section.body.length < 2)) {
        issues.push("a heading and two paragraphs in every report section");
      }
      if (sections.some((section) => section.body.some((paragraph) => !isDetailed(paragraph, 20)))) {
        issues.push("analytical paragraphs with complete detail");
      }
      break;
    }
    case "sheet": {
      const table = draft.table;
      if (!table || table.columns.length < 6 || table.rows.length < 12) {
        issues.push("a table with at least 6 columns and 12 rows");
      } else if (table.rows.some((row) => row.length !== table.columns.length || row.some((cell) => !cell.trim()))) {
        issues.push("a complete value in every table cell");
      }
      break;
    }
    case "agenda": {
      const agenda = draft.agenda ?? [];
      if (agenda.length < 6) issues.push("at least 6 agenda items");
      if (agenda.some((item) => !item.time || !item.owner || !isDetailed(item.topic, 4))) {
        issues.push("a specific timed topic and owner for every agenda item");
      }
      break;
    }
    case "actions": {
      const actions = draft.actions ?? [];
      if (actions.length < 8) issues.push("at least 8 action items");
      if (actions.some((item) => !item.owner || !item.due || !isDetailed(item.task, 5))) {
        issues.push("a detailed task, owner, and due date for every action");
      }
      break;
    }
    case "timeline": {
      const timeline = draft.timeline ?? [];
      if (timeline.length < 5) issues.push("at least 5 timeline phases");
      if (timeline.some((phase) => !phase.phase || !phase.window || !isDetailed(phase.detail, 18))) {
        issues.push("a complete phase, time window, and detailed delivery criteria");
      }
      break;
    }
  }

  return issues;
}

function draftRequest(kind: AssetKind, title: string, request: string, issues: string[] = []): string {
  const retryInstruction = issues.length
    ? `\n\nQUALITY GATE RETRY: Your prior response was incomplete. Regenerate the entire asset, not a patch. It must include ${issues.join(", ")}. Do not shorten any other required content to fit these requirements.`
    : "";
  return `Kind: ${kind}\nTitle: ${title}\nRequest: ${request}${retryInstruction}`;
}

async function generateDeepDraft(kind: AssetKind, title: string, request: string): Promise<AssetDraft> {
  let raw = await groqJson(DRAFT_SYSTEM, draftRequest(kind, title, request), MAX_TOKENS_DRAFT);
  let draft = coerceDraft(raw, kind, title);
  let issues = draftDepthIssues(draft);

  if (issues.length === 0) return draft;

  raw = await groqJson(DRAFT_SYSTEM, draftRequest(kind, title, request, issues), MAX_TOKENS_DRAFT);
  draft = coerceDraft(raw, kind, title);
  issues = draftDepthIssues(draft);

  if (issues.length) {
    throw new Error(`The generated ${kind} did not meet Werk's depth standard: ${issues.join(", ")}`);
  }

  return draft;
}

/** Coerce a raw Groq clarify object into a trusted ClarifyResult. */
function coerceClarify(raw: unknown): ClarifyResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const mode: ClarifyResult["mode"] = obj.mode === "clarify" ? "clarify" : "ready";
  const reply = asString(obj.reply, 200);

  const questions: ClarifyQuestion[] =
    mode === "clarify" && Array.isArray(obj.questions)
      ? (obj.questions as unknown[])
          .map((q) => {
            const o = (q ?? {}) as Record<string, unknown>;
            const key = asString(o.key, 30).replace(/\s+/g, "-").toLowerCase() || "q";
            const question = asString(o.question, 200);
            const placeholder = asString(o.placeholder, 120);
            return { key, question, placeholder: placeholder || undefined } as ClarifyQuestion;
          })
          .filter((q) => q.question)
          .slice(0, 4)
      : [];

  // If the model said "clarify" but produced no usable questions, treat as ready
  // so the client proceeds instead of stalling on an empty form.
  if (mode === "clarify" && questions.length === 0) {
    return { mode: "ready", reply: "", questions: [] };
  }
  return { mode, reply, questions };
}

/* ---------- routes ---------- */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, groq: hasGroqKey() });
});

/* ---------- clarify (run before planning) ---------- */
app.post("/api/clarify", async (req, res) => {
  const request = asString(req.body?.request, 2000).trim();
  if (!request) return res.status(400).json({ error: "request is required" });
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  try {
    const raw = await groqJson(CLARIFY_SYSTEM, request, MAX_TOKENS_CLARIFY);
    res.json(coerceClarify(raw));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "clarify failed" });
  }
});

app.post("/api/plan", async (req, res) => {
  const request = asString(req.body?.request, 2000).trim();
  if (!request) return res.status(400).json({ error: "request is required" });
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  try {
    const raw = await groqJson(PLAN_SYSTEM, request, MAX_TOKENS_PLAN);
    res.json(coercePlan(raw, request));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "plan failed" });
  }
});

app.post("/api/draft", async (req, res) => {
  const kind = asString(req.body?.kind, 20) as AssetKind;
  const title = asString(req.body?.title, 120);
  const request = asString(req.body?.request, 2000);
  if (!VALID_KINDS.has(kind)) return res.status(400).json({ error: "bad kind" });
  if (!title) return res.status(400).json({ error: "title is required" });
  if (!hasGroqKey()) return res.status(503).json({ error: "No Groq key set on the server" });
  try {
    res.json(await generateDeepDraft(kind, title, request));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "draft failed" });
  }
});

app.post("/api/render", async (req, res) => {
  const draft = req.body?.draft as AssetDraft | undefined;
  const format = asString(req.body?.format, 10) as "md" | "pdf" | "pptx" | "xlsx";
  if (!draft || !draft.kind || !VALID_KINDS.has(draft.kind)) {
    return res.status(400).json({ error: "bad draft" });
  }
  if (!["md", "pdf", "pptx", "xlsx"].includes(format)) {
    return res.status(400).json({ error: "bad format" });
  }
  try {
    const result = await renderDraft(draft, format);
    const safeTitle = (draft.title || "asset").replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "asset";
    res.setHeader("Content-Type", result.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${result.ext}"`);
    res.send(result.bytes);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "render failed" });
  }
});

/* ---------- package (zip of every rendered asset) ----------
 * The client sends the package name plus one { draft, format } per asset it
 * kept. Each is rendered to its native format, numbered so the order matches
 * the plan and titles can never collide, and bundled with a short index. */
app.post("/api/package", async (req, res) => {
  const packageName = asString(req.body?.packageName, 80).trim();
  const itemsRaw = Array.isArray(req.body?.items) ? req.body.items : [];

  const items: { draft: AssetDraft; format: RenderFormat }[] = [];
  for (const it of itemsRaw) {
    const o = (it ?? {}) as Record<string, unknown>;
    const draft = o.draft as AssetDraft | undefined;
    const format = asString(o.format, 10) as RenderFormat;
    if (!draft || !draft.kind || !VALID_KINDS.has(draft.kind)) continue;
    if (!["md", "pdf", "pptx", "xlsx"].includes(format)) continue;
    items.push({ draft, format });
  }

  if (items.length === 0) {
    return res.status(400).json({ error: "no assets to package" });
  }

  try {
    const zip = new JSZip();
    const index: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const { draft, format } = items[i];
      const result = await renderDraft(draft, format);
      const safe = (draft.title || "asset")
        .replace(/[^a-z0-9\-_ ]/gi, "")
        .trim()
        .slice(0, 60) || "asset";
      const num = String(i + 1).padStart(2, "0");
      const name = `${num} ${safe}.${result.ext}`;
      zip.file(name, result.bytes);
      index.push(`- ${name}`);
    }

    // a one-file index so the recipient sees what the package contains
    const pkgName = packageName || "Package";
    const indexMd = [
      `# ${pkgName}`,
      "",
      `${items.length} asset${items.length === 1 ? "" : "s"} in this package, assembled by WERK.`,
      "",
      index.join("\n"),
      "",
    ].join("\n");
    zip.file("00 INDEX.md", indexMd);

    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const safePkg = pkgName
      .replace(/[^a-z0-9\-_ ]/gi, "")
      .trim()
      .slice(0, 60) || "package";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safePkg}.zip"`);
    res.send(bytes);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "package failed" });
  }
});

/* ---------- generate stream (SSE) ----------
 * One POST, one stream: {plan} first, then {draft} per asset, then {done}. */
app.post("/api/generate", async (req, res) => {
  const request = asString(req.body?.request, 2000).trim();
  if (!request) {
    return res.status(400).json({ error: "request is required" });
  }
  if (!hasGroqKey()) {
    return res.status(503).json({ error: "No Groq key set on the server" });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const fail = (message: string) => {
    send({ type: "error", message });
    res.end();
  };

  try {
    // 1. plan
    const rawPlan = await groqJson(PLAN_SYSTEM, request, MAX_TOKENS_PLAN);
    const plan = coercePlan(rawPlan, request);
    send({ type: "plan", plan });

    if (plan.assets.length === 0) {
      send({ type: "done" });
      return res.end();
    }

    // 2. draft each asset in turn (sequential + paced, kinder to the Groq free
    //    tier per-minute token limit; the 429 retry in groq.ts backstops)
    for (let i = 0; i < plan.assets.length; i++) {
      const asset = plan.assets[i];
      if (i > 0) await new Promise((r) => setTimeout(r, DRAFT_PACE_MS));
      try {
        const draft = await generateDeepDraft(asset.kind, asset.title, request);
        send({ type: "draft", id: asset.id, draft });
      } catch (err) {
        // one asset failing should not kill the whole package
        send({
          type: "draft-error",
          id: asset.id,
          message: err instanceof Error ? err.message : "draft failed",
        });
      }
    }

    send({ type: "done" });
    res.end();
  } catch (err) {
    fail(err instanceof Error ? err.message : "generate failed");
  }
});

/* ---------- static (built frontend, if served from here) ---------- */
const clientDist = path.resolve(__dirname, "../../dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) res.status(204).end();
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`\n  werk API on http://localhost:${PORT}  (groq: ${hasGroqKey() ? "on" : "off"})\n`);
});
