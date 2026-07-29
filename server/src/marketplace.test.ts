import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { createMarketplaceRouter } from "./marketplace.js";
import type { AssetDraft, PackagePlan, WorkspaceContext } from "./types.js";

const secret = "marketplace-test-secret-1234567890";
const workspace: WorkspaceContext = {
  organizationName: "Marketplace request",
  organizationDescription: "No organization context was supplied.",
  workspacePurpose: "Create useful professional work outputs from the supplied request.",
};
const plan: PackagePlan = {
  packageName: "Launch package",
  packageTitle: "Product launch package",
  reply: "Review the work plan before drafting it.",
  brief: {
    objective: "Prepare a clear product launch package.",
    audience: "Launch team",
    decision: "Approve the launch plan.",
    timing: "Before launch week",
    knownDetails: ["The launch requires a clear owner for every action."],
    openInputs: [],
    sharedTerms: ["product launch"],
    consistencyRules: ["Keep the plan practical and consistent."],
  },
  assets: [{
    id: "a1",
    kind: "document",
    title: "Product launch plan",
    summary: "A complete launch plan for the team.",
    purpose: "Prepare the team for launch.",
    audience: "Launch team",
    decision: "Approve the launch plan.",
    requiredAnalysis: ["Show launch responsibilities and key decisions."],
    acceptanceCriteria: ["Give the team a practical next step."],
    evidenceIds: [],
    dependencies: [],
  }],
};
const draft: AssetDraft = {
  kind: "document",
  title: "Product launch plan",
  blurb: "A practical plan that keeps launch responsibilities and decisions visible for the team.",
  sections: [{
    heading: "Launch decision",
    body: ["Approve the release scope and assign a single accountable owner before the final launch readiness review."],
  }],
};

type Config = Parameters<typeof createMarketplaceRouter>[0];
type Operations = Parameters<typeof createMarketplaceRouter>[1];

function config(overrides: Partial<NonNullable<Config>> = {}): NonNullable<Config> {
  return {
    enabled: true,
    tokenSecret: secret,
    timeoutMs: 1000,
    maxConcurrent: 1,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 10,
    ...overrides,
  };
}

function operations(overrides: Partial<NonNullable<Operations>> = {}): NonNullable<Operations> {
  return {
    createPlan: async () => plan,
    createDraft: async () => draft,
    ...overrides,
  };
}

async function withProvider(router: ReturnType<typeof createMarketplaceRouter>, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/a2mcp/werk", router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider test server did not expose a TCP address.");
  const baseUrl = `http://127.0.0.1:${address.port}/a2mcp/werk`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function post(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("returns a safe unavailable response until the provider is configured", async () => {
  await withProvider(createMarketplaceRouter(config({ enabled: false, tokenSecret: "" }), operations()), async (baseUrl) => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "PROVIDER_UNAVAILABLE", message: "The Werk marketplace provider is not available." },
    });
  });
});

test("plans work and drafts only an asset from its encrypted continuation", async () => {
  let planInput: unknown;
  let draftInput: unknown;
  await withProvider(createMarketplaceRouter(config(), operations({
    createPlan: async (input) => {
      planInput = input;
      return plan;
    },
    createDraft: async (input) => {
      draftInput = input;
      return draft;
    },
  })), async (baseUrl) => {
    const discovery = await fetch(baseUrl);
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).endpoint, "/a2mcp/werk");

    const planResponse = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
      openInputs: ["Needs your input: launch date"],
    });
    assert.equal(planResponse.status, 200);
    const planned = await planResponse.json() as { result: { plan: PackagePlan; continuationToken: string } };
    assert.deepEqual(planned.result.plan, plan);
    assert.equal(typeof planned.result.continuationToken, "string");

    const draftResponse = await post(baseUrl, {
      operation: "draft",
      continuationToken: planned.result.continuationToken,
      assetId: "a1",
    });
    assert.equal(draftResponse.status, 200);
    const drafted = await draftResponse.json() as { result: { draft: AssetDraft; artifact: { parts: Array<{ raw?: string; filename: string; media_type: string }> } } };
    assert.deepEqual(drafted.result.draft, draft);
    assert.equal(drafted.result.artifact.parts[0].filename.endsWith(".pdf"), true);
    assert.equal(typeof drafted.result.artifact.parts[0].raw, "string");
  });

  const receivedPlan = planInput as {
    request: string;
    workspaceContext: WorkspaceContext;
    openInputs: string[];
    signal: AbortSignal;
  };
  assert.deepEqual({
    request: receivedPlan.request,
    workspaceContext: receivedPlan.workspaceContext,
    openInputs: receivedPlan.openInputs,
  }, {
    request: "Prepare a product launch package.",
    workspaceContext: workspace,
    openInputs: ["Needs your input: launch date"],
  });
  assert.equal(receivedPlan.signal.aborted, false);
  assert.equal((draftInput as { assetPlan: { id: string } }).assetPlan.id, "a1");
  assert.equal((draftInput as { request: string }).request, "Prepare a product launch package.");
});

test("rejects malformed, altered, and rate-limited provider requests", async () => {
  await withProvider(createMarketplaceRouter(config({ rateLimitMax: 2 }), operations()), async (baseUrl) => {
    const malformed = await post(baseUrl, { operation: "plan" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");

    const invalidToken = await post(baseUrl, {
      operation: "draft",
      continuationToken: "not-a-token",
      assetId: "a1",
    });
    assert.equal(invalidToken.status, 400);
    assert.equal((await invalidToken.json() as { error: { code: string } }).error.code, "INVALID_CONTINUATION");

    const rateLimited = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
    });
    assert.equal(rateLimited.status, 429);
    assert.equal((await rateLimited.json() as { error: { code: string } }).error.code, "RATE_LIMITED");
  });
});

test("returns a timeout response when the generation operation is cancelled", async () => {
  await withProvider(createMarketplaceRouter(config({ timeoutMs: 10 }), operations({
    createPlan: async ({ signal }) => await new Promise<PackagePlan>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  })), async (baseUrl) => {
    const response = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "TIMED_OUT");
  });
});
