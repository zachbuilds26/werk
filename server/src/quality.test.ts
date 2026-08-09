import assert from "node:assert/strict";
import { test } from "node:test";
import { validateDraftQuality } from "./quality.js";
import { assetDraftSchema, requestPayloadSchema } from "./schemas.js";
import { coerceDraft } from "./workflows.js";

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

test("coerced drafts always satisfy the draft schema at its limits", () => {
  // coerceDraft runs on raw model output and its result is then schema-validated.
  // If the coercion caps are looser than the schema's, a valid generation is
  // thrown away as malformed. These cases previously failed.
  const overlong = {
    title: "Operating review",
    blurb: "A blurb long enough to read as a real summary line for the asset.",
    sections: [{ heading: "Findings", body: Array.from({ length: 9 }, (_, i) => `Paragraph ${i + 1} carrying a full sentence of substance.`) }],
    table: {
      columns: Array.from({ length: 14 }, (_, i) => `Column ${i + 1}`),
      rows: Array.from({ length: 30 }, (_, r) => Array.from({ length: 14 }, (_, c) => `r${r}c${c}`)),
    },
    slides: [{ eyebrow: "Context", title: "Where we are", bullets: Array.from({ length: 9 }, (_, i) => `Bullet ${i + 1} with real wording.`) }],
  };

  for (const kind of ["document", "sheet", "deck"] as const) {
    const coerced = coerceDraft(overlong, kind, "Operating review");
    const parsed = assetDraftSchema.safeParse(coerced);
    assert.equal(parsed.success, true, `${kind} draft was coerced into a shape the schema rejects`);
  }
});

test("coerced sheet rows never exceed the coerced column count", () => {
  const coerced = coerceDraft({
    title: "Budget",
    blurb: "A blurb long enough to read as a real summary line for the asset.",
    table: { columns: ["Item", "Cost"], rows: [["Venue", "1000", "stray", "extra"]] },
  }, "sheet", "Budget");

  const table = coerced.table;
  assert.ok(table, "expected a coerced table");
  for (const row of table.rows) {
    assert.equal(row.length <= table.columns.length, true, "row is wider than the header");
  }
});

test("rejects unrecognised fields at the API boundary", () => {
  const payload = requestPayloadSchema.safeParse({
    request: "Prepare a proposal for a new client",
    unexpected: "must not pass",
  });

  assert.equal(payload.success, false);
});
