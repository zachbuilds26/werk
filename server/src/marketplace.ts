import crypto from "node:crypto";
import express from "express";
import { marketplaceInvocationSchema } from "./schemas.js";
import { createContinuationToken, readContinuationToken } from "./marketplace-token.js";
import { buildArtifactDescriptor, renderFileForDraft } from "./artifacts.js";
import { buildPackageZip, type PackageEntry } from "./package-build.js";
import { PackageStore, type StoredFile } from "./package-store.js";
import { createDraft, createPlan } from "./workflows.js";
import type { AssetKind } from "./types.js";
import type { WerkPaymentListing } from "./okx-payment.js";
import { WERK_PAYMENT_DESCRIPTION } from "./okx-payment.js";

const PROVIDER_PATH = "/a2mcp/werk";
const FILES_SEGMENT = "files";
const PACKAGE_FILE_ID = "package.zip";

type MarketplaceConfig = {
  enabled: boolean;
  tokenSecret: string;
  timeoutMs: number;
  packageTimeoutMs: number;
  /** Time held back so the zip, the base64 encode and the response still fit after the last draft. */
  packageReserveMs: number;
  /** Below this much remaining budget, starting another asset only risks losing it mid-flight. */
  minAssetMs: number;
  inlineMaxBytes: number;
  maxConcurrent: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
};

type MarketplaceOperations = {
  createPlan: typeof createPlan;
  createDraft: typeof createDraft;
};

type RateLimitEntry = { count: number; resetAt: number };

type PackageAssetResult = {
  id: string;
  title: string;
  kind: AssetKind;
  status: "ready" | "skipped";
  format?: string;
  filename?: string;
  byteLength?: number;
  url?: string;
  reason?: string;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function marketplaceConfig(env = process.env): MarketplaceConfig {
  return {
    enabled: env.MARKETPLACE_PROVIDER_ENABLED === "true",
    tokenSecret: env.MARKETPLACE_TOKEN_SECRET ?? "",
    timeoutMs: positiveInteger(env.MARKETPLACE_REQUEST_TIMEOUT_MS, 55000),
    // A whole package is one plan plus a draft per asset, so it needs minutes
    // rather than seconds. Kept inside the 300s the x402 offer advertises.
    packageTimeoutMs: positiveInteger(env.MARKETPLACE_PACKAGE_TIMEOUT_MS, 240000),
    packageReserveMs: positiveInteger(env.MARKETPLACE_PACKAGE_RESERVE_MS, 15000),
    minAssetMs: positiveInteger(env.MARKETPLACE_MIN_ASSET_MS, 35000),
    inlineMaxBytes: positiveInteger(env.MARKETPLACE_INLINE_MAX_BYTES, 6_000_000),
    maxConcurrent: positiveInteger(env.MARKETPLACE_MAX_CONCURRENT, 1),
    rateLimitWindowMs: positiveInteger(env.MARKETPLACE_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
    rateLimitMax: positiveInteger(env.MARKETPLACE_RATE_LIMIT_MAX, 6),
  };
}

function providerError(res: express.Response, requestId: string, status: number, code: string, message: string): void {
  res.status(status).type("application/json").json({ requestId, error: { code, message } });
}

function callerKey(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function marketplaceDiscoveryReady(config: MarketplaceConfig): boolean {
  return config.enabled;
}

function marketplaceOperationReady(config: MarketplaceConfig, payment?: WerkPaymentListing | null): boolean {
  return config.enabled && config.tokenSecret.length >= 32 && (payment ? payment.ready : true);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function createMarketplaceRouter(
  config = marketplaceConfig(),
  operations: MarketplaceOperations = { createPlan, createDraft },
  payment: WerkPaymentListing | null = null,
  store: PackageStore = new PackageStore(),
): express.Router {
  const router = express.Router();
  const rateLimits = new Map<string, RateLimitEntry>();
  let activeRequests = 0;

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    next();
  });

  // Free service metadata. The paid resource itself answers 402 on GET and POST
  // (x402 discovery probes with GET and treats a 200 as "not an x402 service"),
  // so unpaid metadata lives here instead of on the resource path.
  router.get("/info", (_req, res) => {
    if (!marketplaceDiscoveryReady(config)) {
      return res.status(503).json({ error: { code: "PROVIDER_UNAVAILABLE", message: "The Werk marketplace provider is not available." } });
    }
    if (!payment) {
      return res.json({
        name: "Werk",
        version: "1.0",
        endpoint: PROVIDER_PATH,
        pricing: "free",
        operations: ["package", "plan", "draft"],
        defaultOperation: "package",
      });
    }
    return res.json({
      name: "Werk",
      version: "1.0",
      endpoint: PROVIDER_PATH,
      description: payment.description,
      pricing: payment.pricing,
      payment: {
        scheme: payment.scheme,
        network: payment.network,
        asset: payment.asset,
        payTo: payment.payTo,
        mimeType: payment.mimeType,
      },
      operations: ["package", "plan", "draft"],
      defaultOperation: "package",
    });
  });

  // An x402 client replays the paid resource with GET, so GET has to do the same
  // work POST does. Without a GET handler the replay fell through this router to
  // the SPA catch-all and a paying caller received index.html instead of output.
  // A buyer's request can arrive under any number of reasonable names, and the
  // x402 replay forwards only the URL, so anything not read here is lost. Being
  // liberal about the key is the difference between a buyer getting output and
  // getting an error they cannot diagnose.
  const REQUEST_KEYS = [
    "request", "q", "prompt", "query", "input", "text", "task", "description",
    "message", "brief", "ask", "requirement", "requirements", "content",
  ];

  const invocationFromQuery = (query: Record<string, unknown>): unknown => {
    const str = (value: unknown): string | undefined => {
      if (typeof value === "string" && value.trim()) return value.trim();
      // Express yields an array when a key repeats; take the first usable one.
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim()) return item.trim();
        }
      }
      return undefined;
    };

    // Case-insensitive lookup, so `Request` or `PROMPT` work the same way.
    const lower = new Map<string, unknown>();
    for (const [key, value] of Object.entries(query)) lower.set(key.toLowerCase(), value);
    const pick = (...names: string[]): string | undefined => {
      for (const name of names) {
        const found = str(lower.get(name.toLowerCase()));
        if (found) return found;
      }
      return undefined;
    };

    // Whole payload in one param, for callers that can carry JSON in a URL.
    const payload = pick("payload", "body", "json");
    if (payload) {
      try {
        return JSON.parse(payload);
      } catch {
        // Not JSON after all — fall through and treat it as request text.
      }
    }

    const operation = pick("operation", "op", "mode");
    if (operation === "draft") {
      return {
        operation,
        continuationToken: pick("continuationToken", "continuation_token", "token"),
        assetId: pick("assetId", "asset_id", "asset"),
      };
    }

    let request = pick(...REQUEST_KEYS);

    // Last resort: a caller that appends the request with no key at all, e.g.
    // ...?Create%20a%20proposal — Express parses that as an empty-valued key.
    if (!request) {
      for (const [key, value] of Object.entries(query)) {
        if (value === "" && key.trim() && !REQUEST_KEYS.includes(key.toLowerCase()) && key.length > 12) {
          request = decodeURIComponent(key).trim();
          break;
        }
      }
    }

    if (!request) return undefined;
    // Anything that is not explicitly the old two-step flow buys the whole
    // package. A bare ?request=... is the common case and must not return a plan
    // the buyer then has to pay again to act on.
    const invocation: Record<string, unknown> = { operation: operation === "plan" ? "plan" : "package", request };

    const openInputs = pick("openInputs", "open_inputs");
    if (openInputs) {
      try {
        const parsed = JSON.parse(openInputs);
        if (Array.isArray(parsed)) invocation.openInputs = parsed;
      } catch {
        invocation.openInputs = openInputs.split(",").map((item) => item.trim()).filter(Boolean);
      }
    }
    return invocation;
  };

  const fileUrl = (req: express.Request, packageId: string, fileId: string): string => {
    const base = `${req.protocol}://${req.get("host") ?? "werk-rou3.onrender.com"}`;
    return `${base}${req.baseUrl || PROVIDER_PATH}/${FILES_SEGMENT}/${packageId}/${fileId}`;
  };

  const runInvocation = async (rawInvocation: unknown, req: express.Request, res: express.Response): Promise<void> => {
    const requestId = crypto.randomUUID();
    if (!marketplaceOperationReady(config, payment)) {
      return providerError(res, requestId, 503, "PROVIDER_UNAVAILABLE", "The Werk marketplace provider is not available. Try again later.");
    }

    const now = Date.now();
    for (const [entryKey, entryValue] of rateLimits) {
      if (entryValue.resetAt <= now) rateLimits.delete(entryKey);
    }
    const key = callerKey(req);
    const entry = rateLimits.get(key);
    if (entry && entry.count >= config.rateLimitMax) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return providerError(res, requestId, 429, "RATE_LIMITED", "Too many requests. Try again later.");
    }
    if (activeRequests >= config.maxConcurrent) {
      res.setHeader("Retry-After", "60");
      return providerError(res, requestId, 429, "BUSY", "The provider is finishing another package. Try again shortly.");
    }
    const parsed = marketplaceInvocationSchema.safeParse(rawInvocation);
    if (!parsed.success) {
      // A rejected call is never settled, so this costs the caller nothing. Give
      // back everything needed to retry correctly: the missing field, and a URL
      // they can copy, rather than prose they have to interpret.
      const base = `${req.protocol}://${req.get("host") ?? "werk-rou3.onrender.com"}${req.baseUrl || PROVIDER_PATH}`;
      res.status(400).json({
        requestId,
        error: {
          code: "INVALID_REQUEST",
          message: "Add your request to the endpoint URL. The x402 replay forwards only that URL, so the request has to travel on it.",
        },
        inputRequired: true,
        fields: [
          {
            name: "request",
            type: "string",
            required: true,
            description: "What you need in plain language. Also accepted: q, prompt, task, brief, description.",
          },
        ],
        example: `${base}?request=${encodeURIComponent("Create a client proposal for a website redesign")}`,
        howTo: "When creating the task, pass that full URL (with your own request text) as the endpoint. One call returns the plan and every finished file.",
      });
      return;
    }

    // Counted only once the request is known to be well formed, so a caller is
    // not billed quota for a malformed body that never reaches the model.
    rateLimits.set(key, { count: (entry?.count ?? 0) + 1, resetAt: entry?.resetAt ?? now + config.rateLimitWindowMs });

    const invocation = parsed.data;
    const budgetMs = invocation.operation === "package" ? config.packageTimeoutMs : config.timeoutMs;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), budgetMs);
    // A client that hung up is different from a budget that ran out: there is no
    // one left to send partial work to, so the package branch stops rather than
    // spending the remaining time rendering into a closed socket.
    let clientGone = false;
    const abort = () => controller.abort();
    const onClose = () => {
      clientGone = true;
      abort();
    };
    // "close" on the response covers a client that hung up mid-request; the
    // request's "aborted" event is deprecated.
    res.once("close", onClose);
    activeRequests += 1;

    try {
      if (invocation.operation === "package") {
        const openInputs = invocation.openInputs ?? [];
        const plan = await operations.createPlan({ request: invocation.request, openInputs, signal: controller.signal });

        const deadline = startedAt + budgetMs - config.packageReserveMs;
        const entries: PackageEntry[] = [];
        const files = new Map<string, StoredFile>();
        const results: PackageAssetResult[] = [];
        const fileIds: string[] = [];

        for (const asset of plan.assets) {
          if (clientGone) return;
          if (deadline - Date.now() < config.minAssetMs) {
            results.push({
              id: asset.id, title: asset.title, kind: asset.kind, status: "skipped",
              reason: "Not enough time left in this request to write it. Ask again for this one output on its own.",
            });
            continue;
          }
          try {
            const draft = await operations.createDraft({
              request: invocation.request,
              openInputs,
              assetPlan: asset,
              brief: plan.brief,
              signal: controller.signal,
            });
            const rendered = await renderFileForDraft(draft);
            const fileId = crypto.randomUUID();
            files.set(fileId, { bytes: rendered.bytes, mime: rendered.mime, filename: rendered.filename });
            fileIds.push(fileId);
            entries.push({ title: draft.title, ext: rendered.ext, bytes: rendered.bytes, gaps: draft.metadata?.gaps });
            results.push({
              id: asset.id, title: draft.title, kind: asset.kind, status: "ready",
              format: rendered.ext, filename: rendered.filename, byteLength: rendered.bytes.length,
            });
          } catch (error) {
            // One asset failing is not the buyer's problem to pay for twice: the
            // rest of the package still ships and the gap is named.
            results.push({
              id: asset.id, title: asset.title, kind: asset.kind, status: "skipped",
              reason: controller.signal.aborted ? "The time budget for this request ran out before it was finished." : errorMessage(error, "That output could not be written."),
            });
          }
        }

        if (clientGone) return;
        // Only a package with nothing in it is a failure. Anything else ships.
        if (!entries.length) {
          return providerError(res, requestId, 503, "GENERATION_UNAVAILABLE", "Werk could not produce any of the outputs for this request. You have not been charged for a delivery.");
        }

        const zip = await buildPackageZip(plan.packageName, entries);
        files.set(PACKAGE_FILE_ID, { bytes: zip.bytes, mime: "application/zip", filename: zip.filename });
        const { packageId, expiresAt } = store.save(files);

        let readyIndex = 0;
        for (const result of results) {
          if (result.status === "ready") result.url = fileUrl(req, packageId, fileIds[readyIndex++]);
        }

        const inline = zip.bytes.length <= config.inlineMaxBytes;
        res.status(200).json({
          requestId,
          result: {
            operation: "package",
            plan,
            assets: results,
            package: {
              filename: zip.filename,
              media_type: "application/zip",
              byteLength: zip.bytes.length,
              url: fileUrl(req, packageId, PACKAGE_FILE_ID),
              // The zip travels inline so the buyer's saved response is the
              // durable copy; the links are convenience and expire with the store.
              ...(inline ? { raw: zip.bytes.toString("base64") } : {}),
            },
            openInputs: zip.gaps,
            delivered: entries.length,
            skipped: results.length - entries.length,
            expiresAt,
            ...(inline ? {} : { note: "The package was too large to inline. Download it from the url before it expires." }),
          },
        });
        return;
      }

      if (invocation.operation === "plan") {
        const openInputs = invocation.openInputs ?? [];
        const plan = await operations.createPlan({ request: invocation.request, openInputs, signal: controller.signal });
        const continuationToken = createContinuationToken(config.tokenSecret, { request: invocation.request, openInputs, plan });
        res.status(200).json({ requestId, result: { operation: "plan", plan, continuationToken } });
        return;
      }

      const draftRequest = invocation;
      let continuation: ReturnType<typeof readContinuationToken>;
      try {
        continuation = readContinuationToken(config.tokenSecret, draftRequest.continuationToken);
      } catch {
        return providerError(res, requestId, 400, "INVALID_CONTINUATION", "The plan continuation is invalid or has expired. Create a new plan.");
      }
      const assetPlan = continuation.plan.assets.find((asset) => asset.id === draftRequest.assetId);
      if (!assetPlan) return providerError(res, requestId, 400, "INVALID_ASSET", "The selected asset is not in the approved plan.");
      const draft = await operations.createDraft({
        request: continuation.request,
        openInputs: continuation.openInputs,
        assetPlan,
        brief: continuation.plan.brief,
        signal: controller.signal,
      });
      const rendered = await renderFileForDraft(draft);
      const artifact = buildArtifactDescriptor(draft, rendered, { artifactId: crypto.randomUUID() });
      res.status(200).json({ requestId, result: { operation: "draft", draft, artifact } });
      return;
    } catch (error) {
      if (clientGone) return;
      if (controller.signal.aborted) return providerError(res, requestId, 504, "TIMED_OUT", "The provider could not finish in time. Try again later.");
      return providerError(res, requestId, 503, "GENERATION_UNAVAILABLE", "The provider is temporarily unavailable. Try again later.");
    } finally {
      activeRequests -= 1;
      clearTimeout(timeout);
      res.off("close", onClose);
    }
  };

  router.post("/", (req, res) => runInvocation(req.body, req, res));
  router.get("/", (req, res) => runInvocation(invocationFromQuery(req.query as Record<string, unknown>), req, res));

  // Nothing under the provider mount may fall through to the SPA catch-all: a
  // paying caller must always receive JSON, never index.html.
  router.use((req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: `No Werk provider route for ${req.method} ${req.originalUrl}.` },
    });
  });

  return router;
}

export { PROVIDER_PATH, FILES_SEGMENT, PACKAGE_FILE_ID, WERK_PAYMENT_DESCRIPTION };
