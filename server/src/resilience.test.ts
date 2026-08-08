import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { createRateLimiter, isA2APath } from "./rate-limit.js";
import { keepAliveUrl, startKeepAlive } from "./keepalive.js";

async function withServer(app: express.Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("turns a caller away once the window quota is spent", async () => {
  const app = express();
  app.use(createRateLimiter({ max: 2, windowMs: 60_000, maxConcurrent: 8 }));
  app.get("/", (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(baseUrl)).status, 200);
    assert.equal((await fetch(baseUrl)).status, 200);

    const blocked = await fetch(baseUrl);
    assert.equal(blocked.status, 429);
    // Derived from the time left in the window, so it can tick down mid-test.
    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 60, `retry-after out of range: ${retryAfter}`);
    assert.equal((await blocked.json() as { error: { code: string } }).error.code, "RATE_LIMITED");
  });
});

test("releases a concurrency slot when the client hangs up mid-response", async () => {
  const app = express();
  app.use(createRateLimiter({ max: 100, windowMs: 60_000, maxConcurrent: 1 }));
  app.get("/hang", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("open");
    // deliberately never ended: the client aborts instead
  });
  app.get("/quick", (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const controller = new AbortController();
    const hanging = fetch(`${baseUrl}/hang`, { signal: controller.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));

    // The only slot is taken, so a second caller is shed rather than queued.
    assert.equal((await fetch(`${baseUrl}/quick`)).status, 503);

    controller.abort();
    await hanging;
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Aborting must hand the slot back rather than leak it.
    assert.equal((await fetch(`${baseUrl}/quick`)).status, 200);
  });
});

test("derives the keepalive target only from a usable public URL", () => {
  assert.equal(keepAliveUrl({} as NodeJS.ProcessEnv), null);
  assert.equal(keepAliveUrl({ RENDER_EXTERNAL_URL: "   " } as NodeJS.ProcessEnv), null);
  assert.equal(keepAliveUrl({ RENDER_EXTERNAL_URL: "werk.example" } as NodeJS.ProcessEnv), null);
  assert.equal(
    keepAliveUrl({ RENDER_EXTERNAL_URL: "https://werk.example/" } as NodeJS.ProcessEnv),
    "https://werk.example/api/health",
  );
  // An explicit PUBLIC_URL wins over the platform-provided value.
  assert.equal(
    keepAliveUrl({ PUBLIC_URL: "https://a.example", RENDER_EXTERNAL_URL: "https://b.example" } as NodeJS.ProcessEnv),
    "https://a.example/api/health",
  );
});

test("keeps the keepalive off locally and when explicitly disabled", () => {
  const off = startKeepAlive({} as NodeJS.ProcessEnv);
  assert.equal(off.enabled, false);
  off.stop();

  const disabled = startKeepAlive({
    RENDER_EXTERNAL_URL: "https://werk.example",
    KEEPALIVE_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  assert.equal(disabled.enabled, false);
  disabled.stop();

  const on = startKeepAlive({ RENDER_EXTERNAL_URL: "https://werk.example" } as NodeJS.ProcessEnv);
  assert.equal(on.enabled, true);
  assert.equal(on.url, "https://werk.example/api/health");
  on.stop();
});

// The agent gate carries a wildcard CORS header and the agent concurrency cap.
// If it ever matches /api again, the browser app inherits an agent-sized
// concurrency limit and every origin can spend the quota.
test("agent middleware matches only the A2A surface", () => {
  for (const path of [
    "/message:send",
    "/message:stream",
    "/werk/message:send",
    "/werk/message:stream",
    "/tasks/abc",
    "/werk/tasks/abc",
    "/tasks/abc/artifacts/def",
    "/werk/tasks/abc/artifacts/def",
  ]) {
    assert.equal(isA2APath(path), true, `expected an agent path: ${path}`);
  }

  for (const path of [
    "/api/plan",
    "/api/generate",
    "/api/render",
    "/api/health",
    "/a2mcp/werk",
    "/a2mcp/werk/tools/call",
    "/.well-known/agent-card.json",
    "/",
    "/workspace",
    "/docs",
    "/assets/index.js",
  ]) {
    assert.equal(isA2APath(path), false, `expected a non-agent path: ${path}`);
  }
});
