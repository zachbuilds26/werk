import assert from "node:assert/strict";
import { test } from "node:test";
import { DRAFT_SYSTEM, PLAN_SYSTEM } from "./prompts.js";

test("generation prompts prohibit invented business facts", () => {
  const prompts = `${PLAN_SYSTEM}\n${DRAFT_SYSTEM}`.toLowerCase();
  assert.equal(prompts.includes("invent realistic"), false);
  assert.equal(prompts.includes("figures are illustrative starting points"), false);
  assert.equal(prompts.includes("never invent or imply a real date, amount, metric, owner"), true);
  assert.equal(prompts.includes("needs your input:"), true);
});

test("planning recommends a small reviewed set of outputs", () => {
  assert.equal(PLAN_SYSTEM.includes("Choose 1 to 4 outputs"), true);
  assert.equal(PLAN_SYSTEM.includes("small, helpful set of outputs"), true);
});

test("prompts tell the model it gets one request and no follow-up", () => {
  // The product promise is that one sentence is enough. If a prompt ever starts
  // asking for details before working, that promise is broken at the source.
  for (const prompt of [PLAN_SYSTEM, DRAFT_SYSTEM]) {
    assert.equal(prompt.includes("no chance to ask a follow-up question"), true);
  }
});
