import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { groqJson } from "./groq.js";

const keyNames = ["GROQ_API_KEY", "GROQ_API_KEY_2", "GROQ_API_KEY_3", "GROQ_API_KEYS"] as const;
const originalEnv = new Map(keyNames.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

function setKeys(values: Partial<Record<(typeof keyNames)[number], string>>): void {
  for (const name of keyNames) delete process.env[name];
  Object.assign(process.env, values);
}

function response(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(...responses: Response[]): string[] {
  const keys: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const authorization = new Headers(init?.headers).get("Authorization");
    keys.push(authorization?.replace("Bearer ", "") ?? "");
    const next = responses.shift();
    if (!next) throw new Error("Unexpected Groq request");
    return next;
  }) as typeof fetch;
  return keys;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  for (const name of keyNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("uses the second configured key after a daily quota response", async () => {
  setKeys({ GROQ_API_KEY: "primary", GROQ_API_KEY_2: "secondary" });
  const keys = mockFetch(
    response(429, '{"error":{"message":"tokens per day limit reached"}}'),
    response(200, '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}')
  );

  const result = await groqJson<{ ok: boolean }>("system", "user");

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(keys, ["primary", "secondary"]);
});

test("retries a per-minute quota response with the same key", async () => {
  setKeys({ GROQ_API_KEY: "primary" });
  const delays: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    callback();
    return undefined as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const keys = mockFetch(
    response(429, '{"error":{"message":"rate limit reached"}}'),
    response(200, '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}')
  );

  await groqJson("system", "user");

  assert.deepEqual(keys, ["primary", "primary"]);
  assert.deepEqual(delays, [12000]);
});

test("rotates to the next key when the primary credential is invalid", async () => {
  setKeys({ GROQ_API_KEY: "primary", GROQ_API_KEY_2: "secondary" });
  const keys = mockFetch(
    response(401, '{"error":{"message":"invalid API key"}}'),
    response(200, '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}')
  );

  await groqJson("system", "user");

  assert.deepEqual(keys, ["primary", "secondary"]);
});

test("deduplicates configured keys and does not expose provider response bodies", async () => {
  setKeys({
    GROQ_API_KEY: "primary",
    GROQ_API_KEY_2: "primary",
    GROQ_API_KEYS: "primary, primary",
  });
  const keys = mockFetch(response(429, '{"error":{"message":"sensitive-provider-detail tokens per day"}}'));

  await assert.rejects(
    groqJson("system", "user"),
    (error: Error) =>
      error.message === "Groq is temporarily unavailable. Try again shortly." &&
      !error.message.includes("sensitive-provider-detail")
  );
  assert.deepEqual(keys, ["primary"]);
});
