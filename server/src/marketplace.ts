import crypto from "node:crypto";
import express from "express";
import { marketplaceInvocationSchema } from "./schemas.js";
import { createContinuationToken, readContinuationToken } from "./marketplace-token.js";
import { buildArtifactDescriptor, renderFileForDraft } from "./artifacts.js";
import { createDraft, createPlan } from "./workflows.js";
import type { WorkspaceContext } from "./types.js";
import type { WerkPaymentListing } from "./okx-payment.js";
import { WERK_PAYMENT_DESCRIPTION } from "./okx-payment.js";

const PROVIDER_PATH = "/a2mcp/werk";
const DEFAULT_WORKSPACE: WorkspaceContext = {
  organizationName: "Marketplace request",
  organizationDescription: "No organization context was supplied.",
  workspacePurpose: "Create useful professional work outputs from the supplied request.",
};

type MarketplaceConfig = {
  enabled: boolean;
  tokenSecret: string;
  timeoutMs: number;
  maxConcurrent: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
};

type MarketplaceOperations = {
  createPlan: typeof createPlan;
  createDraft: typeof createDraft;
};

type RateLimitEntry = { count: number; resetAt: number };

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function marketplaceConfig(env = process.env): MarketplaceConfig {
  return {
    enabled: env.MARKETPLACE_PROVIDER_ENABLED === "true",
    tokenSecret: env.MARKETPLACE_TOKEN_SECRET ?? "",
    timeoutMs: positiveInteger(env.MARKETPLACE_REQUEST_TIMEOUT_MS, 55000),
    maxConcurrent: positiveInteger(env.MARKETPLACE_MAX_CONCURRENT, 1),
    rateLimitWindowMs: positiveInteger(env.MARKETPLACE_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
    rateLimitMax: positiveInteger(env.MARKETPLACE_RATE_LIMIT_MAX, 4),
  };
}

function providerError(res: express.Response, requestId: string, status: number, code: string, message: string): void {
  res.status(status).type("application/json").json({ requestId, error: { code, message } });
}

function callerKey(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function defaultWorkspace(context?: Partial<WorkspaceContext>): WorkspaceContext {
  return { ...DEFAULT_WORKSPACE, ...context };
}

function marketplaceDiscoveryReady(config: MarketplaceConfig): boolean {
  return config.enabled;
}

function marketplaceOperationReady(config: MarketplaceConfig, payment?: WerkPaymentListing | null): boolean {
  return config.enabled && config.tokenSecret.length >= 32 && (payment ? payment.ready : true);
}

export function createMarketplaceRouter(
  config = marketplaceConfig(),
  operations: MarketplaceOperations = { createPlan, createDraft },
  payment: WerkPaymentListing | null = null,
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
        operations: ["plan", "draft"],
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
      operations: ["plan", "draft"],
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

    const operation = pick("operation", "op", "mode") ?? "plan";
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
    const invocation: Record<string, unknown> = { operation: "plan", request };

    const workspaceContext = pick("workspaceContext", "workspace_context", "context");
    if (workspaceContext) {
      try {
        invocation.workspaceContext = JSON.parse(workspaceContext);
      } catch {
        // A malformed context is dropped rather than failing the whole call;
        // defaultWorkspace() supplies a usable fallback.
      }
    }

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
      res.setHeader("Retry-After", "30");
      return providerError(res, requestId, 429, "BUSY", "The provider is busy. Try again shortly.");
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
        howTo: "When creating the task, pass that full URL (with your own request text) as the endpoint.",
      });
      return;
    }

    // Counted only once the request is known to be well formed, so a caller is
    // not billed quota for a malformed body that never reaches the model.
    rateLimits.set(key, { count: (entry?.count ?? 0) + 1, resetAt: entry?.resetAt ?? now + config.rateLimitWindowMs });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const abort = () => controller.abort();
    // "close" on the response covers a client that hung up mid-request; the
    // request's "aborted" event is deprecated.
    res.once("close", abort);
    activeRequests += 1;

    try {
      if (parsed.data.operation === "plan") {
        const workspaceContext = defaultWorkspace(parsed.data.workspaceContext);
        const openInputs = parsed.data.openInputs ?? [];
        const plan = await operations.createPlan({ request: parsed.data.request, workspaceContext, openInputs, signal: controller.signal });
        const continuationToken = createContinuationToken(config.tokenSecret, { request: parsed.data.request, workspaceContext, openInputs, plan });
        res.status(200).json({ requestId, result: { operation: "plan", plan, continuationToken } });
        return;
      }

      const draftRequest = parsed.data;
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
        workspaceContext: continuation.workspaceContext,
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
      if (controller.signal.aborted) return providerError(res, requestId, 504, "TIMED_OUT", "The provider could not finish in time. Try again later.");
      return providerError(res, requestId, 503, "GENERATION_UNAVAILABLE", "The provider is temporarily unavailable. Try again later.");
    } finally {
      activeRequests -= 1;
      clearTimeout(timeout);
      res.off("close", abort);
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

export { PROVIDER_PATH, WERK_PAYMENT_DESCRIPTION };
