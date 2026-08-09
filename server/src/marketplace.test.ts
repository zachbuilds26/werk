import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { FILES_SEGMENT, createMarketplaceRouter } from "./marketplace.js";
import { PackageStore, createPackageFilesRouter } from "./package-store.js";
import { buildWerkPaymentListing, OKX_PAYMENT_ASSET, OKX_PAYMENT_NETWORK, WERK_PAYMENT_DESCRIPTION, WERK_PAYMENT_PRICE_LABEL } from "./okx-payment.js";
import type { AssetDraft, PackagePlan } from "./types.js";

const secret = "marketplace-test-secret-1234567890";
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
    packageTimeoutMs: 60_000,
    packageReserveMs: 10,
    minAssetMs: 10,
    inlineMaxBytes: 6_000_000,
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
    const response = await fetch(`${baseUrl}/info`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "PROVIDER_UNAVAILABLE", message: "The Werk marketplace provider is not available." },
    });
  });
});

test("keeps discovery online when payment setup is incomplete", async () => {
  const payment = buildWerkPaymentListing("0xd9002c9e91516ce9ad0155a0d9d9e3092d64ac23", "0.01", false);
  await withProvider(createMarketplaceRouter(config({ tokenSecret: "" }), operations(), payment), async (baseUrl) => {
    const discovery = await fetch(`${baseUrl}/info`);
    assert.equal(discovery.status, 200);
    const discovered = await discovery.json() as {
      endpoint: string;
      payment: { payTo: string };
    };
    assert.equal(discovered.endpoint, "/a2mcp/werk");
    assert.equal(discovered.payment.payTo, payment.payTo);
  });
});

test("returns paid discovery metadata and keeps the plan/draft flow intact", async () => {
  const payment = buildWerkPaymentListing("0xd9002c9e91516ce9ad0155a0d9d9e3092d64ac23");
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
  }), payment), async (baseUrl) => {
    const discovery = await fetch(`${baseUrl}/info`);
    assert.equal(discovery.status, 200);
    const discovered = await discovery.json() as {
      endpoint: string;
      description: string;
      pricing: string;
      payment: { scheme: string; network: string; asset: string; payTo: string; mimeType: string };
      operations: string[];
    };
    assert.equal(discovered.endpoint, "/a2mcp/werk");
    assert.equal(discovered.description, WERK_PAYMENT_DESCRIPTION);
    assert.equal(discovered.pricing, WERK_PAYMENT_PRICE_LABEL);
    assert.deepEqual(discovered.payment, {
      scheme: "exact",
      network: OKX_PAYMENT_NETWORK,
      asset: OKX_PAYMENT_ASSET,
      payTo: payment.payTo,
      mimeType: "application/json",
    });
    assert.deepEqual(discovered.operations, ["package", "plan", "draft"]);

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
    openInputs: string[];
    signal: AbortSignal;
  };
  assert.deepEqual({
    request: receivedPlan.request,
    openInputs: receivedPlan.openInputs,
  }, {
    request: "Prepare a product launch package.",
    openInputs: ["Needs your input: launch date"],
  });
  assert.equal(receivedPlan.signal.aborted, false);
  assert.equal((draftInput as { assetPlan: { id: string } }).assetPlan.id, "a1");
  assert.equal((draftInput as { request: string }).request, "Prepare a product launch package.");
});

test("rejects malformed, altered, and rate-limited provider requests", async () => {
  await withProvider(createMarketplaceRouter(config({ rateLimitMax: 2 }), operations()), async (baseUrl) => {
    // A body that fails the contract is rejected before it costs the caller
    // any quota, so this request must not count toward the limit below.
    const malformed = await post(baseUrl, { operation: "plan" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");

    // Well formed, so it is counted, even though the token itself is rejected.
    const invalidToken = await post(baseUrl, {
      operation: "draft",
      continuationToken: "not-a-token",
      assetId: "a1",
    });
    assert.equal(invalidToken.status, 400);
    assert.equal((await invalidToken.json() as { error: { code: string } }).error.code, "INVALID_CONTINUATION");

    const accepted = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
    });
    assert.equal(accepted.status, 200);

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

test("a paid GET does the work instead of falling through to the SPA", async () => {
  // The x402 client replays the paid resource with GET. Before this, the router
  // had no GET handler, so the replay fell past it to the SPA catch-all and a
  // paying caller received index.html. The catch-all below reproduces that
  // production layout, so this test fails loudly if GET ever escapes again.
  let planRequest = "";
  const app = express();
  app.use(express.json());
  app.use("/a2mcp/werk", createMarketplaceRouter(config(), operations({
    createPlan: async (input) => {
      planRequest = input.request;
      return plan;
    },
  })));
  app.get(/^(?!\/api).*/, (_req, res) => res.type("html").send("<!doctype html><html></html>"));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider test server did not expose a TCP address.");
  const baseUrl = `http://127.0.0.1:${address.port}/a2mcp/werk`;

  try {
    const query = new URLSearchParams({ operation: "plan", request: "Create a one-page client proposal" });
    const response = await fetch(`${baseUrl}?${query.toString()}`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);

    const body = await response.json() as { result: { operation: string; continuationToken: string } };
    assert.equal(body.result.operation, "plan");
    assert.ok(body.result.continuationToken.length > 0);
    assert.equal(planRequest, "Create a one-page client proposal");

    // An unusable GET must still answer JSON, never the SPA shell.
    const bare = await fetch(baseUrl);
    assert.equal(bare.status, 400);
    assert.match(bare.headers.get("content-type") ?? "", /application\/json/);
    assert.equal((await bare.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");

    // Unknown subpaths under the mount stay JSON too.
    const missing = await fetch(`${baseUrl}/nope`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type") ?? "", /application\/json/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("accepts the request under any common key, casing, or repetition", async () => {
  // The x402 replay forwards only the endpoint URL, so a request that arrives
  // under an unexpected key is lost entirely. Buyers should not have to know
  // one exact parameter name.
  const seen: string[] = [];
  const app = express();
  app.use(express.json());
  app.use("/a2mcp/werk", createMarketplaceRouter(config(), operations({
    createPlan: async (input) => { seen.push(input.request); return plan; },
  })));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}/a2mcp/werk`;

  try {
    for (const qs of ["request=Build+a+deck", "q=Build+a+deck", "prompt=Build+a+deck", "Request=Build+a+deck", "TASK=Build+a+deck"]) {
      const res = await fetch(`${baseUrl}?${qs}`);
      assert.equal(res.status, 200, `expected 200 for ${qs}`);
    }
    assert.equal(seen.length, 5);
    assert.ok(seen.every((r) => r === "Build a deck"), `unexpected requests: ${JSON.stringify(seen)}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

test("a request-less call returns a copyable example instead of prose", async () => {
  await withProvider(createMarketplaceRouter(config(), operations()), async (baseUrl) => {
    const res = await fetch(baseUrl);
    assert.equal(res.status, 400);

    const body = await res.json() as { inputRequired: boolean; fields: { name: string; required: boolean }[]; example: string };
    assert.equal(body.inputRequired, true);
    assert.ok(body.fields.some((f) => f.name === "request" && f.required));

    // The example must itself be a working call, not illustrative text.
    assert.ok(body.example.includes("?request="), `example lacks a request param: ${body.example}`);
    const replay = await fetch(body.example);
    assert.equal(replay.status, 200, "the example URL should succeed as-is");
  });
});

// --- one paid call, whole package -------------------------------------------

const sheetDraft: AssetDraft = {
  kind: "sheet",
  title: "Launch budget tracker",
  blurb: "A tracker that keeps every launch cost line visible and easy to update as real numbers arrive.",
  table: {
    columns: ["Item", "Owner", "Cost"],
    rows: [["Venue", "Needs your input: owner", "Needs your input: cost"]],
  },
};

const threeAssetPlan: PackagePlan = {
  ...plan,
  assets: [
    plan.assets[0],
    { ...plan.assets[0], id: "a2", kind: "sheet", title: "Launch budget tracker" },
    { ...plan.assets[0], id: "a3", title: "Launch comms plan" },
  ],
};

const draftPerKind: NonNullable<Operations>["createDraft"] = async ({ assetPlan }) =>
  assetPlan.kind === "sheet" ? sheetDraft : { ...draft, title: assetPlan.title };

type PackageBody = {
  result: {
    operation: string;
    plan: PackagePlan;
    assets: { id: string; status: string; format?: string; filename?: string; url?: string; reason?: string }[];
    package: { filename: string; byteLength: number; url: string; raw?: string };
    delivered: number;
    skipped: number;
    expiresAt: number;
  };
};

/** Mounts the paid router and the free download router over one shared store, the way index.ts does. */
async function withPackageProvider(
  ops: NonNullable<Operations>,
  cfg: NonNullable<Config>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const store = new PackageStore();
  const app = express();
  app.use(express.json());
  app.use(`/a2mcp/werk/${FILES_SEGMENT}`, createPackageFilesRouter(store));
  app.use("/a2mcp/werk", createMarketplaceRouter(cfg, ops, null, store));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  try {
    await run(`http://127.0.0.1:${address.port}/a2mcp/werk`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
}

test("one paid call returns the plan, every rendered file, and an inline zip", async () => {
  await withPackageProvider(
    operations({ createPlan: async () => threeAssetPlan, createDraft: draftPerKind }),
    config(),
    async (baseUrl) => {
      const response = await post(baseUrl, { operation: "package", request: "Prepare a product launch package." });
      assert.equal(response.status, 200);

      const body = await response.json() as PackageBody;
      assert.equal(body.result.operation, "package");
      assert.deepEqual(body.result.plan, threeAssetPlan);
      assert.equal(body.result.delivered, 3);
      assert.equal(body.result.skipped, 0);
      assert.equal(body.result.assets.length, 3);
      assert.ok(body.result.assets.every((asset) => asset.status === "ready"), JSON.stringify(body.result.assets));

      // Real renders, not descriptors: the sheet must come back as a workbook.
      assert.deepEqual(body.result.assets.map((asset) => asset.format), ["pdf", "xlsx", "pdf"]);
      assert.ok(body.result.assets.every((asset) => (asset.url ?? "").includes(`/${FILES_SEGMENT}/`)));

      // The zip travels inline so the buyer's saved response is self-contained.
      assert.ok(body.result.package.byteLength > 0);
      assert.equal(typeof body.result.package.raw, "string");
      assert.equal(Buffer.from(body.result.package.raw ?? "", "base64").subarray(0, 2).toString(), "PK");
      assert.ok(body.result.expiresAt > Date.now());
    },
  );
});

test("a bare request buys the package, not a plan the buyer must pay again to use", async () => {
  await withPackageProvider(operations({ createDraft: draftPerKind }), config(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}?request=${encodeURIComponent("Prepare a product launch package.")}`);
    assert.equal(response.status, 200);
    const body = await response.json() as PackageBody;
    assert.equal(body.result.operation, "package");
    assert.equal(body.result.delivered, 1);
  });
});

test("a package ships the assets that succeeded when one of them fails", async () => {
  await withPackageProvider(
    operations({
      createPlan: async () => threeAssetPlan,
      createDraft: async (input) => {
        if (input.assetPlan.id === "a2") throw new Error("The model returned a malformed draft.");
        return { ...draft, title: input.assetPlan.title };
      },
    }),
    config(),
    async (baseUrl) => {
      const response = await post(baseUrl, { operation: "package", request: "Prepare a product launch package." });
      // A buyer who paid must never receive nothing because one output broke.
      assert.equal(response.status, 200);

      const body = await response.json() as PackageBody;
      assert.equal(body.result.delivered, 2);
      assert.equal(body.result.skipped, 1);
      const failed = body.result.assets.find((asset) => asset.id === "a2");
      assert.equal(failed?.status, "skipped");
      assert.match(failed?.reason ?? "", /malformed draft/);
      assert.equal(typeof body.result.package.raw, "string");
    },
  );
});

test("a package with nothing in it is an error rather than an empty success", async () => {
  await withPackageProvider(
    operations({ createDraft: async () => { throw new Error("no model"); } }),
    config(),
    async (baseUrl) => {
      const response = await post(baseUrl, { operation: "package", request: "Prepare a product launch package." });
      assert.equal(response.status, 503);
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, "GENERATION_UNAVAILABLE");
    },
  );
});

test("a package short on time delivers what it has instead of timing out", async () => {
  const slowDraft: NonNullable<Operations>["createDraft"] = async ({ assetPlan }) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ...draft, title: assetPlan.title };
  };

  await withPackageProvider(
    operations({ createPlan: async () => threeAssetPlan, createDraft: slowDraft }),
    // Enough budget for the first output but not all three, so the run has to
    // stop starting new work and ship what it finished.
    config({ packageTimeoutMs: 900, packageReserveMs: 10, minAssetMs: 250 }),
    async (baseUrl) => {
      const response = await post(baseUrl, { operation: "package", request: "Prepare a product launch package." });
      assert.equal(response.status, 200);

      const body = await response.json() as PackageBody;
      assert.ok(body.result.delivered >= 1, `expected at least one delivered, got ${body.result.delivered}`);
      assert.ok(body.result.skipped >= 1, `expected at least one skipped, got ${body.result.skipped}`);
      assert.equal(body.result.delivered + body.result.skipped, 3);

      const skipped = body.result.assets.find((asset) => asset.status === "skipped");
      assert.match(skipped?.reason ?? "", /time/i);
      // The buyer paid, so whatever finished still ships as a real zip.
      assert.equal(typeof body.result.package.raw, "string");
    },
  );
});

test("a delivered file downloads from its url without paying again", async () => {
  await withPackageProvider(operations({ createDraft: draftPerKind }), config(), async (baseUrl) => {
    const response = await post(baseUrl, { operation: "package", request: "Prepare a product launch package." });
    const body = await response.json() as PackageBody;

    const file = await fetch(body.result.assets[0].url ?? "");
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") ?? "", /application\/pdf/);
    assert.match(file.headers.get("content-disposition") ?? "", /attachment; filename=/);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "%PDF");

    const zip = await fetch(body.result.package.url);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get("content-type") ?? "", /application\/zip/);

    // An expired or invented id answers JSON, never the SPA shell.
    const missing = await fetch(`${baseUrl}/${FILES_SEGMENT}/nope/nope`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type") ?? "", /application\/json/);
  });
});
