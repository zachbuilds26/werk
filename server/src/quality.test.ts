import assert from "node:assert/strict";
import { test } from "node:test";
import { validateDraftQuality } from "./quality.js";
import { requestPayloadSchema } from "./schemas.js";

test("rejects skeletal action lists and retired illustrative content", () => {
  const issues = validateDraftQuality({
    kind: "actions",
    title: "Launch actions",
    blurb: "Figures are illustrative starting points; replace with your actuals.",
    actions: [{ task: "Align team [date]", owner: "", due: "" }],
  });

  assert.equal(issues.some((issue) => issue.code === "action-count"), true);
  assert.equal(issues.some((issue) => issue.code === "missing-field"), true);
  assert.equal(issues.some((issue) => issue.code === "invented-content"), true);
  assert.equal(issues.some((issue) => issue.code === "placeholder"), true);
});

test("accepts visible open inputs instead of invented dates or owners", () => {
  const actions = Array.from({ length: 6 }, (_, index) => ({
    task: `Prepare the next agreed deliverable for workstream ${index + 1} and record the outcome for review.`,
    owner: "Needs your input: responsible person",
    due: "Needs your input: due date",
  }));
  const issues = validateDraftQuality({
    kind: "actions",
    title: "Website launch task list",
    blurb: "A practical draft task list that keeps responsibility and timing visible for confirmation.",
    actions,
  });

  assert.deepEqual(issues.filter((issue) => issue.severity === "error"), []);
});

test("rejects unrecognised fields at the API boundary", () => {
  const payload = requestPayloadSchema.safeParse({
    request: "Prepare a proposal for a new client",
    workspaceContext: {
      organizationName: "Maya Studio",
      organizationDescription: "Independent web designer",
      workspacePurpose: "Client proposals and project handovers",
    },
    unexpected: "must not pass",
  });

  assert.equal(payload.success, false);
});
