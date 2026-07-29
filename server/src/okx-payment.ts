import type { RequestHandler } from "express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import type { RoutesConfig } from "@okxweb3/x402-core/server";
import { x402ResourceServer } from "@okxweb3/x402-core/server";
import { paymentMiddleware } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

export const OKX_PAYMENT_NETWORK = "eip155:196" as const;
export const OKX_PAYMENT_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736" as const;
export const WERK_PAYMENT_ROUTE = "POST /a2mcp/werk" as const;
export const WERK_PAYMENT_DESCRIPTION =
  "Werk turns one plain-language request into a plan and draft business assets such as presentations, reports, spreadsheets, agendas, action items, and timelines. Each POST is billed separately in USDT0 on X Layer, and drafts may surface missing inputs that the buyer still needs to confirm.";
export const WERK_PAYMENT_DEFAULT_PRICE = "0.01" as const;
export const WERK_PAYMENT_PRICE_LABEL = `${WERK_PAYMENT_DEFAULT_PRICE} USDT0 / POST` as const;
export const WERK_PAYMENT_ROUTE_PRICE = `$${WERK_PAYMENT_DEFAULT_PRICE}` as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type WerkPaymentListing = {
  ready: boolean;
  description: string;
  pricing: string;
  scheme: "exact";
  network: typeof OKX_PAYMENT_NETWORK;
  asset: typeof OKX_PAYMENT_ASSET;
  payTo: string;
  mimeType: "application/json";
};

export type WerkPaymentHealth = {
  enabled: boolean;
  ready: boolean;
  recipientConfigured: boolean;
  credentialsConfigured: boolean;
  price: string;
  network: typeof OKX_PAYMENT_NETWORK;
  asset: typeof OKX_PAYMENT_ASSET;
  reasons: string[];
};

export type WerkPaymentIntegration = {
  middleware: RequestHandler;
  listing: WerkPaymentListing;
  health: WerkPaymentHealth;
  routes: RoutesConfig | null;
};

function trim(value: string | undefined): string {
  return value?.trim() ?? "";
}

function readPrice(value: string | undefined): string {
  const raw = trim(value).replace(/^\$/, "");
  if (!raw) return WERK_PAYMENT_DEFAULT_PRICE;
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) throw new Error("OKX payment price must be a positive decimal string.");
  if (Number(raw) <= 0) throw new Error("OKX payment price must be greater than zero.");
  return raw;
}

function readRecipient(value: string | undefined): string | null {
  const raw = trim(value);
  if (!raw) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) throw new Error("OKX payment recipient must be a valid EVM address.");
  return raw;
}

function buildListing(ready: boolean, recipient: string | null, price: string): WerkPaymentListing {
  return {
    ready,
    description: WERK_PAYMENT_DESCRIPTION,
    pricing: WERK_PAYMENT_PRICE_LABEL.replace(WERK_PAYMENT_DEFAULT_PRICE, price),
    scheme: "exact",
    network: OKX_PAYMENT_NETWORK,
    asset: OKX_PAYMENT_ASSET,
    payTo: recipient ?? ZERO_ADDRESS,
    mimeType: "application/json",
  };
}

export function buildWerkPaymentListing(recipient: string | null, price: string = WERK_PAYMENT_DEFAULT_PRICE, ready = true): WerkPaymentListing {
  return buildListing(ready, recipient, price);
}

export function buildWerkPaymentRoutes(recipient: string, price: string = WERK_PAYMENT_DEFAULT_PRICE): RoutesConfig {
  return {
    [WERK_PAYMENT_ROUTE]: {
      accepts: {
        scheme: "exact",
        network: OKX_PAYMENT_NETWORK,
        payTo: recipient,
        price: `$${price}`,
      },
      description: WERK_PAYMENT_DESCRIPTION,
      mimeType: "application/json",
    },
  };
}

export function createWerkPaymentIntegration(env = process.env): WerkPaymentIntegration {
  const enabled = env.OKX_PAYMENT_ENABLED === "true";
  const price = enabled ? readPrice(env.OKX_PAYMENT_PRICE_USDT0) : WERK_PAYMENT_DEFAULT_PRICE;
  const recipient = readRecipient(env.OKX_PAYMENT_RECIPIENT);
  const apiKey = trim(env.OKX_API_KEY);
  const secretKey = trim(env.OKX_SECRET_KEY);
  const passphrase = trim(env.OKX_PASSPHRASE);
  const baseUrl = trim(env.OKX_FACILITATOR_BASE_URL);
  const credentialsConfigured = Boolean(apiKey && secretKey && passphrase);
  const ready = enabled && Boolean(recipient) && credentialsConfigured;
  const reasons: string[] = [];

  if (!enabled) reasons.push("payment disabled");
  if (enabled && !recipient) reasons.push("missing payment recipient");
  if (enabled && !credentialsConfigured) reasons.push("missing facilitator credentials");

  const listing = buildListing(ready, recipient, price);
  const health: WerkPaymentHealth = {
    enabled,
    ready,
    recipientConfigured: Boolean(recipient),
    credentialsConfigured,
    price,
    network: OKX_PAYMENT_NETWORK,
    asset: OKX_PAYMENT_ASSET,
    reasons,
  };
  const paymentRecipient = recipient ?? ZERO_ADDRESS;

  if (!ready) {
    return {
      middleware: (_req, _res, next) => next(),
      listing,
      health,
      routes: null,
    };
  }

  const facilitator = new OKXFacilitatorClient({
    apiKey,
    secretKey,
    passphrase,
    ...(baseUrl ? { baseUrl } : {}),
  });
  const resourceServer = new x402ResourceServer(facilitator).register(OKX_PAYMENT_NETWORK, new ExactEvmScheme());
  const routes = buildWerkPaymentRoutes(paymentRecipient, price);
  const middleware = paymentMiddleware(routes, resourceServer, undefined, undefined, false);
  const bootstrap = resourceServer.initialize().catch(() => undefined);

  return {
    middleware: async (req, res, next) => {
      await bootstrap;
      return middleware(req, res, next);
    },
    listing,
    health,
    routes,
  };
}
