import crypto from "node:crypto";
import express from "express";
import { marketplaceInvocationSchema } from "./schemas.js";
import { createContinuationToken, readContinuationToken } from "./marketplace-token.js";
import { buildArtifactDescriptor, renderFileForDraft } from "./artifacts.js";
import { createDraft, createPlan } from "./workflows.js";
import type { WorkspaceContext } from "./types.js";

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

export function createMarketplaceRouter(
  config = marketplaceConfig(),
  operations: MarketplaceOperations = { createPlan, createDraft },
): express.Router {
  const router = express.Router();
  const rateLimits = new Map<string, RateLimitEntry>();
  let activeRequests = 0;

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    next();
  });

  router.get("/", (_req, res) => {
    if (!config.enabled || config.tokenSecret.length < 32) {
      return res.status(503).json({ error: { code: "PROVIDER_UNAVAILABLE", message: "The Werk marketplace provider is not available." } });
    }
    return res.json({
      name: "Werk",
      version: "1.0",
      endpoint: PROVIDER_PATH,
      pricing: "free",
      operations: ["plan", "draft"],
    });
  });

  router.post("/", async (req, res) => {
    const requestId = crypto.randomUUID();
    if (!config.enabled || config.tokenSecret.length < 32) {
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
    rateLimits.set(key, { count: (entry?.count ?? 0) + 1, resetAt: entry?.resetAt ?? now + config.rateLimitWindowMs });

    const parsed = marketplaceInvocationSchema.safeParse(req.body);
    if (!parsed.success) return providerError(res, requestId, 400, "INVALID_REQUEST", "The request does not match the Werk provider contract.");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const abort = () => controller.abort();
    req.once("aborted", abort);
    activeRequests += 1;

    try {
      if (parsed.data.operation === "plan") {
        const workspaceContext = defaultWorkspace(parsed.data.workspaceContext);
        const openInputs = parsed.data.openInputs ?? [];
        const plan = await operations.createPlan({ request: parsed.data.request, workspaceContext, openInputs, signal: controller.signal });
        const continuationToken = createContinuationToken(config.tokenSecret, { request: parsed.data.request, workspaceContext, openInputs, plan });
        return res.status(200).json({ requestId, result: { operation: "plan", plan, continuationToken } });
      }

      if (parsed.data.operation !== "draft") {
        return providerError(res, requestId, 400, "INVALID_REQUEST", "The request does not match the Werk provider contract.");
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
      return res.status(200).json({ requestId, result: { operation: "draft", draft, artifact } });
    } catch (error) {
      if (controller.signal.aborted) return providerError(res, requestId, 504, "TIMED_OUT", "The provider could not finish in time. Try again later.");
      return providerError(res, requestId, 503, "GENERATION_UNAVAILABLE", "The provider is temporarily unavailable. Try again later.");
    } finally {
      activeRequests -= 1;
      clearTimeout(timeout);
      req.off("aborted", abort);
    }
  });

  return router;
}

export { PROVIDER_PATH };
