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

  // Records the shape of the last call that reached the paid resource. A buyer's
  // request only arrives if the x402 client forwards it, and that is invisible
  // from outside — without this, diagnosing a wrong-shaped paid call costs a
  // real payment per attempt. Shape only: no header values, no payment proof.
  let lastInvocation: {
    at: string;
    method: string;
    originalUrl: string;
    queryKeys: string[];
    query: Record<string, string>;
    bodyKeys: string[];
    hasBody: boolean;
    contentType: string | null;
  } | null = null;

  const recordInvocation = (req: express.Request): void => {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.query as Record<string, unknown>)) {
      query[key] = typeof value === "string" ? value.slice(0, 300) : JSON.stringify(value).slice(0, 300);
    }
    const body = (req.body ?? null) as Record<string, unknown> | null;
    lastInvocation = {
      at: new Date().toISOString(),
      method: req.method,
      originalUrl: req.originalUrl.slice(0, 400),
      queryKeys: Object.keys(query),
      query,
      bodyKeys: body && typeof body === "object" ? Object.keys(body) : [],
      hasBody: Boolean(body && typeof body === "object" && Object.keys(body).length > 0),
      contentType: req.get("content-type") ?? null,
    };
  };

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    next();
  });

  // Free. Reports how the last paid call arrived so a failed purchase can be
  // diagnosed without paying again.
  router.get("/last-invocation", (_req, res) => {
    res.json({ lastInvocation });
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
  const invocationFromQuery = (query: Record<string, unknown>): unknown => {
    const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

    // Whole payload in one param, for callers that can carry JSON in a URL.
    const payload = str(query.payload);
    if (payload) {
      try {
        return JSON.parse(payload);
      } catch {
        return undefined;
      }
    }

    const operation = str(query.operation) ?? "plan";
    if (operation === "draft") {
      return { operation, continuationToken: str(query.continuationToken), assetId: str(query.assetId) };
    }

    const request = str(query.request) ?? str(query.q);
    if (!request) return undefined;
    const invocation: Record<string, unknown> = { operation: "plan", request };

    const workspaceContext = str(query.workspaceContext);
    if (workspaceContext) {
      try {
        invocation.workspaceContext = JSON.parse(workspaceContext);
      } catch {
        // A malformed context is dropped rather than failing the whole call;
        // defaultWorkspace() supplies a usable fallback.
      }
    }

    const openInputs = str(query.openInputs);
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
      return providerError(
        res,
        requestId,
        400,
        "INVALID_REQUEST",
        'Send operation="plan" with a request describing the work (POST a JSON body, or pass ?operation=plan&request=... on a GET). Use operation="draft" with continuationToken and assetId to render one asset from a plan.',
      );
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

  router.post("/", (req, res) => { recordInvocation(req); return runInvocation(req.body, req, res); });
  router.get("/", (req, res) => { recordInvocation(req); return runInvocation(invocationFromQuery(req.query as Record<string, unknown>), req, res); });

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
