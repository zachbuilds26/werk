import assert from "node:assert/strict";
import { test } from "node:test";
import { CLARIFY_SYSTEM, DRAFT_SYSTEM, PLAN_SYSTEM } from "./prompts.js";

test("generation prompts prohibit invented business facts", () => {
  const prompts = `${CLARIFY_SYSTEM}\n${PLAN_SYSTEM}\n${DRAFT_SYSTEM}`.toLowerCase();
  assert.equal(prompts.includes("invent realistic"), false);
  assert.equal(prompts.includes("figures are illustrative starting points"), false);
  assert.equal(prompts.includes("never invent or imply a real date, amount, metric, owner"), true);
  assert.equal(prompts.includes("needs your input:"), true);
});

test("planning recommends a small reviewed set of outputs", () => {
  assert.equal(PLAN_SYSTEM.includes("Choose 1 to 4 outputs"), true);
  assert.equal(PLAN_SYSTEM.includes("small, helpful set of outputs"), true);
});
