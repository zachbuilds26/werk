import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWorkspaceRequest,
  coerceWorkspaceContext,
  stripWorkspaceContextBlock,
} from "./workspace.js";

test("coerces a workspace context and trims optional fields", () => {
  assert.equal(
    coerceWorkspaceContext({
      organizationName: "",
      organizationDescription: "",
      workspacePurpose: "",
    }),
    null,
  );

  assert.deepEqual(
    coerceWorkspaceContext({
      organizationName: "  Acme Finance  ",
      organizationDescription: "  B2B expense software  ",
      workspacePurpose: "  Board packs and budgets  ",
      defaultAudience: "  Exec team  ",
      toneAndConstraints: "  Direct, no fluff  ",
      additionalContext: "  Use current quarter numbers  ",
    }),
    {
      organizationName: "Acme Finance",
      organizationDescription: "B2B expense software",
      workspacePurpose: "Board packs and budgets",
      defaultAudience: "Exec team",
      toneAndConstraints: "Direct, no fluff",
      additionalContext: "Use current quarter numbers",
    },
  );
});

test("builds a canonical workspace request block", () => {
  const workspace = {
    organizationName: "Acme Finance",
    organizationDescription: "B2B expense software",
    workspacePurpose: "Board packs and budgets",
    defaultAudience: "Exec team",
  };
  const request = "Conversation so far:\nTurn 1 user request: Prep the Q1 budget\n\nNew user message: Create the Q1 budget";
  const built = buildWorkspaceRequest(workspace, request);

  assert.equal(
    built,
    [
      "Workspace context:",
      "Company or team: Acme Finance",
      "What they do: B2B expense software",
      "Workspace purpose: Board packs and budgets",
      "Default audience: Exec team",
      "",
      request,
    ].join("\n"),
  );
  assert.equal(stripWorkspaceContextBlock(built), request);
  assert.equal(buildWorkspaceRequest(workspace, built), built);
});
