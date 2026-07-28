import crypto from "node:crypto";
import { packagePlanSchema, workspaceContextSchema } from "./schemas.js";
import type { PackagePlan, WorkspaceContext } from "./types.js";

const TOKEN_VERSION = 1;
const TOKEN_TTL_MS = 15 * 60 * 1000;

type ContinuationPayload = {
  version: number;
  issuedAt: number;
  expiresAt: number;
  request: string;
  workspaceContext: WorkspaceContext;
  openInputs: string[];
  plan: PackagePlan;
};

function keyFor(secret: string): Buffer {
  return crypto.scryptSync(secret, "werk-marketplace-continuation", 32);
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function parsePayload(raw: unknown): ContinuationPayload {
  const value = raw as Record<string, unknown>;
  if (value.version !== TOKEN_VERSION || typeof value.issuedAt !== "number" || typeof value.expiresAt !== "number" || typeof value.request !== "string" || !Array.isArray(value.openInputs)) {
    throw new Error("Invalid continuation token");
  }
  const workspace = workspaceContextSchema.safeParse(value.workspaceContext);
  const plan = packagePlanSchema.safeParse(value.plan);
  if (!workspace.success || !plan.success || value.openInputs.some((input) => typeof input !== "string")) throw new Error("Invalid continuation token");
  if (value.expiresAt <= Date.now()) throw new Error("Continuation token expired");
  return {
    version: TOKEN_VERSION,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    request: value.request,
    workspaceContext: workspace.data,
    openInputs: value.openInputs,
    plan: plan.data,
  };
}

export function createContinuationToken(
  secret: string,
  input: Pick<ContinuationPayload, "request" | "workspaceContext" | "openInputs" | "plan">,
  now = Date.now(),
): string {
  if (secret.length < 32) throw new Error("Marketplace token secret is not configured");
  const payload: ContinuationPayload = {
    version: TOKEN_VERSION,
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_MS,
    ...input,
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `${encode(iv)}.${encode(cipher.getAuthTag())}.${encode(encrypted)}`;
}

export function readContinuationToken(secret: string, token: string): ContinuationPayload {
  if (secret.length < 32) throw new Error("Marketplace token secret is not configured");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("Invalid continuation token");
  try {
    const [iv, tag, ciphertext] = parts.map(decode);
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("Invalid continuation token");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(secret), iv);
    decipher.setAuthTag(tag);
    return parsePayload(JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")));
  } catch {
    throw new Error("Invalid continuation token");
  }
}
