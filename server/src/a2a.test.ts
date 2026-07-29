import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { createA2ARouter } from "./a2a.js";
import type { AssetDraft, PackagePlan, WorkspaceContext } from "./types.js";

const workspace: WorkspaceContext = {
  organizationName: "Northstar Labs",
  organizationDescription: "A B2B SaaS company",
  workspacePurpose: "Create board-ready business assets from one request",
};

const plan: PackagePlan = {
  packageName: "Board package",
  packageTitle: "Q4 board pack",
  reply: "Review the package as it is drafted.",
  brief: {
    objective: "Prepare a board pack.",
    audience: "Board and exec team",
    decision: "Approve the plan.",
    timing: "Before Friday",
    knownDetails: ["ARR is 8.4M"],
    openInputs: [],
    sharedTerms: ["Q4 board pack"],
    consistencyRules: ["Keep the tone direct and practical."],
  },
  assets: [{
    id: "a1",
    kind: "deck",
    title: "Board deck",
    summary: "A concise deck for the board.",
    purpose: "Communicate the plan.",
    audience: "Board and exec team",
    decision: "Approve the plan.",
    requiredAnalysis: ["Explain the key decisions."],
    acceptanceCriteria: ["The board can act on it."],
    evidenceIds: [],
    dependencies: [],
  }],
};

const draft: AssetDraft = {
  kind: "deck",
  title: "Board deck",
  blurb: "A clear board deck with the main decisions and actions.",
  slides: [{
    eyebrow: "Decision",
    title: "Approve the plan",
    bullets: ["Hire the team", "Protect runway"],
  }],
};

type A2AResponse =
  | { task?: { id: string; status: { state: string }; artifacts: Array<{ artifact_id: string; parts: Array<{ url?: string; raw?: string; filename: string; media_type: string }> }> } }
  | { status_update?: { task_id: string; status: { state: string; message?: string } } }
  | { artifact_update?: { task_id: string; artifact: { artifact_id: string; parts: Array<{ url?: string; raw?: string; filename: string; media_type: string }> } } };

async function withServer(router: ReturnType<typeof createA2ARouter>, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function collectEvents(response: Response): Promise<A2AResponse[]> {
  if (!response.body) throw new Error("No response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: A2AResponse[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
        if (!line) continue;
        events.push(JSON.parse(line.slice(5).trim()) as A2AResponse);
      }
      if (events.some((event) => "artifact_update" in event)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

async function waitForCompletedTask(baseUrl: string, taskId: string): Promise<{ status: { state: string }; artifacts: Array<{ artifact_id: string; parts: Array<{ url?: string }> }> }> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const response = await fetch(`${baseUrl}/tasks/${taskId}`);
    if (response.ok) {
      const task = (await response.json()) as { status: { state: string }; artifacts: Array<{ artifact_id: string; parts: Array<{ url?: string }> }> };
      if (task.status.state === "completed") return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Task did not complete in time.");
}

test("returns a task, advances status, and stores a rendered artifact", async () => {
  await withServer(createA2ARouter({ heartbeatMs: 5, taskTtlMs: 60_000 }, {
    createPlan: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return plan;
    },
    createDraft: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return draft;
    },
    renderFileForDraft: async () => ({
      bytes: Buffer.from("pptx-bytes"),
      ext: "pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      filename: "Board deck.pptx",
    }),
  }), async (baseUrl) => {
    const response = await post(baseUrl, "/message:send", {
      message: {
        messageId: "msg-1",
        role: "ROLE_USER",
        parts: [{ text: "Prepare a Q4 board pack for our leadership meeting." }],
        metadata: { workspaceContext: workspace },
      },
      configuration: { returnImmediately: true },
      metadata: { workspaceContext: workspace },
    });
    assert.equal(response.status, 200);

    const sent = await response.json() as { task: { id: string; status: { state: string } } };
    assert.equal(["submitted", "working"].includes(sent.task.status.state), true);

    const taskId = sent.task.id;
    const initialTaskResponse = await fetch(`${baseUrl}/tasks/${taskId}`);
    assert.equal(initialTaskResponse.status, 200);
    const initialTask = await initialTaskResponse.json() as { status: { state: string } };
    assert.equal(["submitted", "working", "completed"].includes(initialTask.status.state), true);

    await new Promise((resolve) => setTimeout(resolve, 35));
    const workingTaskResponse = await fetch(`${baseUrl}/tasks/${taskId}`);
    assert.equal(workingTaskResponse.status, 200);
    const workingTask = await workingTaskResponse.json() as { status: { state: string } };
    assert.equal(["working", "completed"].includes(workingTask.status.state), true);

    const task = await waitForCompletedTask(baseUrl, taskId);
    assert.equal(task.artifacts.length, 1);
    assert.ok(task.artifacts[0].parts[0].url);

    const artifactId = task.artifacts[0].artifact_id;
    const artifactResponse = await fetch(`${baseUrl}/tasks/${taskId}/artifacts/${artifactId}`);
    assert.equal(artifactResponse.status, 200);
    assert.ok((artifactResponse.headers.get("content-type") ?? "").includes("presentation"));
    assert.equal(Buffer.from(await artifactResponse.arrayBuffer()).toString("utf8"), "pptx-bytes");
  });
});
