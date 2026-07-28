import assert from "node:assert/strict";
import { test } from "node:test";
import { createContinuationToken, readContinuationToken } from "./marketplace-token.js";
import type { PackagePlan, WorkspaceContext } from "./types.js";

const secret = "marketplace-test-secret-1234567890";
const workspace: WorkspaceContext = {
  organizationName: "Northstar Studio",
  organizationDescription: "A small product design practice",
  workspacePurpose: "Create client-ready project proposals",
};
const plan: PackagePlan = {
  packageName: "Website proposal",
  packageTitle: "Website redesign proposal",
  reply: "Review the suggested work before drafting it.",
  brief: {
    objective: "Prepare a practical website redesign proposal.",
    audience: "Prospective client",
    decision: "Approve the redesign scope.",
    timing: "Before the kickoff meeting",
    knownDetails: ["The site must be mobile-first."],
    openInputs: [],
    sharedTerms: ["website redesign"],
    consistencyRules: ["Keep scope and timing consistent across outputs."],
  },
  assets: [{
    id: "a1",
    kind: "document",
    title: "Website redesign proposal",
    summary: "A clear scope and approach for the client.",
    purpose: "Help the client approve the work.",
    audience: "Prospective client",
    decision: "Approve the redesign scope.",
    requiredAnalysis: ["Describe scope, process, and required decisions."],
    acceptanceCriteria: ["Give the client a clear next step."],
    evidenceIds: [],
    dependencies: [],
  }],
};

function createToken(now = Date.now()): string {
  return createContinuationToken(secret, {
    request: "Prepare a proposal for the website redesign.",
    workspaceContext: workspace,
    openInputs: ["Needs your input: launch date"],
    plan,
  }, now);
}

test("encrypts and restores an approved marketplace plan", () => {
  const token = createToken();
  const restored = readContinuationToken(secret, token);

  assert.equal(token.includes("Northstar Studio"), false);
  assert.equal(restored.request, "Prepare a proposal for the website redesign.");
  assert.deepEqual(restored.workspaceContext, workspace);
  assert.deepEqual(restored.plan, plan);
});

test("rejects altered or expired marketplace continuations", () => {
  const token = createToken();
  const altered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

  assert.throws(() => readContinuationToken(secret, altered), /Invalid continuation token/);
  assert.throws(() => readContinuationToken(secret, createToken(Date.now() - (16 * 60 * 1000))), /Invalid continuation token/);
});
