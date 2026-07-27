import assert from "node:assert/strict";
import { test } from "node:test";
import { validateDraftQuality } from "./quality.js";
import { requestPayloadSchema } from "./schemas.js";

test("rejects skeletal and placeholder action lists", () => {
  const issues = validateDraftQuality({
    kind: "actions",
    title: "Launch actions",
    blurb: "A short list for [Company].",
    actions: [{ task: "Align team", owner: "", due: "" }],
  });

  assert.equal(issues.some((issue) => issue.code === "action-count"), true);
  assert.equal(issues.some((issue) => issue.code === "action-ownership"), true);
  assert.equal(issues.some((issue) => issue.code === "vague-language"), true);
});

test("accepts a complete, decision-ready action list", () => {
  const actions = Array.from({ length: 10 }, (_, index) => ({
    task: `Publish the approved launch checklist, confirm every dependency, and report readiness for workstream ${index + 1}.`,
    owner: "Launch Director",
    due: `Week ${index + 1}`,
  }));
  const issues = validateDraftQuality({
    kind: "actions",
    title: "Billing launch actions",
    blurb: "A complete operating checklist assigns owners, delivery dates, dependencies, and review points for the billing launch decision.",
    actions,
  });

  assert.deepEqual(issues.filter((issue) => issue.severity === "error"), []);
});

test("rejects unrecognised fields at the API boundary", () => {
  const payload = requestPayloadSchema.safeParse({
    request: "Prepare the Q2 board pack",
    workspaceContext: {
      organizationName: "Acme Finance",
      organizationDescription: "Expense software for finance teams",
      workspacePurpose: "Board packs and operating reviews",
    },
    unexpected: "must not pass",
  });

  assert.equal(payload.success, false);
});
