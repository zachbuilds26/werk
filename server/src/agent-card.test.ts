import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { AGENT_CARD_PATH, buildAgentCard, createAgentCardRouter } from "./agent-card.js";

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

// REQUIRED in the A2A specification's AgentCard message. A card missing any of
// these is not discoverable, which is indistinguishable from an agent that is
// down.
const REQUIRED_FIELDS = [
  "name",
  "description",
  "supportedInterfaces",
  "version",
  "capabilities",
  "defaultInputModes",
  "defaultOutputModes",
  "skills",
] as const;

test("agent card carries every field the A2A spec marks required", () => {
  const card = buildAgentCard("https://werk.example") as unknown as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    assert.ok(card[field] !== undefined, `agent card is missing required field: ${field}`);
  }

  for (const field of ["supportedInterfaces", "defaultInputModes", "defaultOutputModes", "skills"] as const) {
    assert.ok(Array.isArray(card[field]), `${field} must be an array`);
    assert.ok((card[field] as unknown[]).length > 0, `${field} must not be empty`);
  }

  // Every AgentInterface entry needs url, protocolBinding and protocolVersion.
  for (const entry of card.supportedInterfaces as { url: string; protocolBinding: string; protocolVersion: string }[]) {
    assert.equal(typeof entry.url, "string");
    assert.ok(entry.url.length > 0, "interface url must not be empty");
    assert.ok(["JSONRPC", "GRPC", "HTTP+JSON"].includes(entry.protocolBinding), `unexpected binding: ${entry.protocolBinding}`);
    assert.ok(entry.protocolVersion.length > 0, "protocolVersion must not be empty");
  }

  // Every AgentSkill needs id, name, description and tags.
  for (const skill of card.skills as { id: string; name: string; description: string; tags: string[] }[]) {
    for (const key of ["id", "name", "description"] as const) {
      assert.equal(typeof skill[key], "string");
      assert.ok(skill[key].length > 0, `skill.${key} must not be empty`);
    }
    assert.ok(Array.isArray(skill.tags) && skill.tags.length > 0, "skill.tags must not be empty");
  }
});

test("agent card advertises the host that served it", () => {
  // A card baked with one host but served from another sends callers to the
  // wrong endpoint, so the URL is derived per request.
  const card = buildAgentCard("https://werk-rou3.onrender.com/");
  assert.equal(card.supportedInterfaces[0].url, "https://werk-rou3.onrender.com");
  assert.equal(card.provider?.url, "https://werk-rou3.onrender.com");
  assert.equal(card.documentationUrl, "https://werk-rou3.onrender.com/docs");
});

test("serves the card as JSON at the well-known path", async () => {
  const app = express();
  app.get(AGENT_CARD_PATH, createAgentCardRouter());
  // Stands in for the SPA catch-all that previously swallowed this path.
  app.get(/.*/, (_req, res) => res.type("html").send("<!doctype html><html></html>"));

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const card = await res.json() as { name: string; skills: unknown[] };
    assert.equal(card.name, "Werk");
    assert.ok(card.skills.length > 0);

    // The regression this guards: HTML with a 200 reads as a broken agent.
    const html = await (await fetch(`${baseUrl}/some-spa-route`)).text();
    assert.match(html, /doctype html/i);
  });
});
