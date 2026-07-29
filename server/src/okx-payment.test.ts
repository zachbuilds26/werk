import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import type { FacilitatorClient } from "@okxweb3/x402-core/server";
import type { PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { registerExactEvmScheme } from "@okxweb3/x402-evm/exact/client";
import { buildWerkPaymentListing, buildWerkPaymentRoutes, OKX_PAYMENT_ASSET, OKX_PAYMENT_NETWORK } from "./okx-payment.js";
import { createMarketplaceRouter, marketplaceConfig } from "./marketplace.js";
import type { AssetDraft, PackagePlan } from "./types.js";

const sellerAddress = "0xd9002c9e91516ce9ad0155a0d9d9e3092d64ac23";
const buyerAddress = "0x1111111111111111111111111111111111111111";
type SupportedResponse = ReturnType<FacilitatorClient["getSupported"]> extends Promise<infer Result> ? Result : never;
type VerifyResponse = Awaited<ReturnType<FacilitatorClient["verify"]>>;
type SettleResponse = Awaited<ReturnType<FacilitatorClient["settle"]>>;

const workspace = {
  organizationName: "Buyer QA",
  organizationDescription: "A test workspace",
  workspacePurpose: "Validate generated work outputs",
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

function createFakeFacilitator(counts: { supported: number; verify: number; settle: number }, expected: () => string): FacilitatorClient {
  return {
    async getSupported(): Promise<SupportedResponse> {
      counts.supported += 1;
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: OKX_PAYMENT_NETWORK }],
        extensions: [],
        signers: { [sellerAddress]: [OKX_PAYMENT_NETWORK] },
      };
    },
    async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
      counts.verify += 1;
      if (paymentRequirements.network !== OKX_PAYMENT_NETWORK) {
        return { isValid: false, invalidReason: "NETWORK_MISMATCH", invalidMessage: "Wrong network.", payer: buyerAddress };
      }
      if (paymentRequirements.asset !== OKX_PAYMENT_ASSET) {
        return { isValid: false, invalidReason: "ASSET_MISMATCH", invalidMessage: "Wrong token.", payer: buyerAddress };
      }
      if (paymentRequirements.payTo !== sellerAddress) {
        return { isValid: false, invalidReason: "PAYEE_MISMATCH", invalidMessage: "Wrong recipient.", payer: buyerAddress };
      }
      if (JSON.stringify(paymentPayload) !== expected()) {
        return { isValid: false, invalidReason: "PAYMENT_TAMPERED", invalidMessage: "Payload changed.", payer: buyerAddress };
      }
      return { isValid: true, payer: buyerAddress };
    },
    async settle(_paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
      counts.settle += 1;
      return {
        success: true,
        status: "success",
        transaction: `0x${"1".repeat(64)}`,
        network: paymentRequirements.network,
        payer: buyerAddress,
        amount: paymentRequirements.amount,
      };
    },
  };
}

async function withServer(
  handler: express.RequestHandler,
  run: (baseUrl: string, setExpectedPaymentPayload: (payload: PaymentPayload) => void, counts: { supported: number; verify: number; settle: number }) => Promise<void>,
): Promise<void> {
  const counts = { supported: 0, verify: 0, settle: 0 };
  let expectedPaymentPayload = "";
  const facilitator = createFakeFacilitator(counts, () => expectedPaymentPayload);
  const resourceServer = new x402ResourceServer(facilitator).register(OKX_PAYMENT_NETWORK, new ExactEvmScheme());
  await resourceServer.initialize();
  const routes = buildWerkPaymentRoutes(sellerAddress);
  const app = express();
  app.use(express.json());
  app.use(paymentMiddleware(routes, resourceServer, undefined, undefined, false));
  app.use("/a2mcp/werk", handler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address.");
  const baseUrl = `http://127.0.0.1:${address.port}/a2mcp/werk`;
  try {
    await run(baseUrl, (payload) => { expectedPaymentPayload = JSON.stringify(payload); }, counts);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function createBuyerClient(): { client: x402Client; httpClient: x402HTTPClient } {
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: {
      address: buyerAddress,
      async signTypedData() {
        return `0x${"2".repeat(130)}` as `0x${string}`;
      },
    },
    networks: [OKX_PAYMENT_NETWORK],
  });
  return { client, httpClient: new x402HTTPClient(client) };
}

async function post(baseUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("returns a 402 challenge with the X Layer USDT0 requirements", async () => {
  const payment = buildWerkPaymentListing(sellerAddress);
  await withServer(createMarketplaceRouter(marketplaceConfig({ MARKETPLACE_PROVIDER_ENABLED: "true", MARKETPLACE_TOKEN_SECRET: "marketplace-test-secret-1234567890" }), { createPlan: async () => plan, createDraft: async () => draft }, payment), async (baseUrl) => {
    const response = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
      workspaceContext: workspace,
      openInputs: ["Needs your input: launch date"],
    });
    assert.equal(response.status, 402);
    const { httpClient } = createBuyerClient();
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) => response.headers.get(name));
    assert.equal(paymentRequired.accepts[0].scheme, "exact");
    assert.equal(paymentRequired.accepts[0].network, OKX_PAYMENT_NETWORK);
    assert.equal(paymentRequired.accepts[0].asset, OKX_PAYMENT_ASSET);
    assert.equal(paymentRequired.accepts[0].payTo, sellerAddress);
    assert.equal(Number(paymentRequired.accepts[0].amount) > 0, true);
  });
});

test("accepts a valid x402 payment and reaches the marketplace handler", async () => {
  const payment = buildWerkPaymentListing(sellerAddress);
  let handlerCalls = 0;
  await withServer(createMarketplaceRouter(marketplaceConfig({ MARKETPLACE_PROVIDER_ENABLED: "true", MARKETPLACE_TOKEN_SECRET: "marketplace-test-secret-1234567890" }), {
    createPlan: async () => {
      handlerCalls += 1;
      return plan;
    },
    createDraft: async () => draft,
  }, payment), async (baseUrl, setExpectedPaymentPayload, counts) => {
    const { client, httpClient } = createBuyerClient();
    const unauthenticated = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
      workspaceContext: workspace,
    });
    assert.equal(unauthenticated.status, 402);
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) => unauthenticated.headers.get(name));
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    setExpectedPaymentPayload(paymentPayload);
    const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);
    const paid = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
      workspaceContext: workspace,
      openInputs: ["Needs your input: launch date"],
    }, headers);
    assert.equal(paid.status, 200);
    const body = await paid.json() as { result: { operation: string; plan: PackagePlan; continuationToken: string } };
    assert.equal(body.result.operation, "plan");
    assert.deepEqual(body.result.plan, plan);
    assert.equal(typeof body.result.continuationToken, "string");
    assert.equal(handlerCalls, 1);
    assert.equal(counts.verify > 0, true);
    assert.equal(counts.settle, 1);
  });
});

test("rejects tampered payment payloads", async () => {
  const payment = buildWerkPaymentListing(sellerAddress);
  await withServer(createMarketplaceRouter(marketplaceConfig({ MARKETPLACE_PROVIDER_ENABLED: "true", MARKETPLACE_TOKEN_SECRET: "marketplace-test-secret-1234567890" }), { createPlan: async () => plan, createDraft: async () => draft }, payment), async (baseUrl, setExpectedPaymentPayload, counts) => {
    const { client, httpClient } = createBuyerClient();
    const unauthenticated = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
      workspaceContext: workspace,
    });
    assert.equal(unauthenticated.status, 402);
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) => unauthenticated.headers.get(name));
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    setExpectedPaymentPayload(paymentPayload);

    const tamperedVariants: Array<{ label: string; mutate: (payload: PaymentPayload) => void }> = [
      { label: "network", mutate: (payload) => { payload.accepted.network = "eip155:1"; } },
      { label: "asset", mutate: (payload) => { payload.accepted.asset = "0x0000000000000000000000000000000000000001"; } },
      { label: "recipient", mutate: (payload) => { payload.accepted.payTo = "0x0000000000000000000000000000000000000002"; } },
      { label: "signature", mutate: (payload) => { payload.payload = { ...payload.payload, tampered: true }; } },
    ];

    for (const { mutate } of tamperedVariants) {
      const tampered = structuredClone(paymentPayload) as PaymentPayload;
      mutate(tampered);
      const response = await post(baseUrl, {
        operation: "plan",
        request: "Prepare a product launch package.",
        workspaceContext: workspace,
      }, httpClient.encodePaymentSignatureHeader(tampered));
      assert.equal(response.status, 402);
    }
    assert.equal(counts.settle, 0);
  });
});

test("does not settle when the application fails after payment verification", async () => {
  await withServer(async (_req, res) => {
    res.status(503).json({ error: "Application unavailable" });
  }, async (baseUrl, setExpectedPaymentPayload, counts) => {
    const { client, httpClient } = createBuyerClient();
    const unauthenticated = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
      workspaceContext: workspace,
    });
    assert.equal(unauthenticated.status, 402);
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) => unauthenticated.headers.get(name));
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    setExpectedPaymentPayload(paymentPayload);
    const paid = await post(baseUrl, {
      operation: "plan",
      request: "Prepare a product launch package.",
      workspaceContext: workspace,
    }, httpClient.encodePaymentSignatureHeader(paymentPayload));
    assert.equal(paid.status, 503);
    assert.equal(counts.verify > 0, true);
    assert.equal(counts.settle, 0);
  });
});
