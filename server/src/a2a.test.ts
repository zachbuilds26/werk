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

type PublishedDeliverable = {
  artifact_id: string;
  filename: string;
  media_type: string;
  byteLength: number;
  url?: string;
};

type TaskSnapshot = {
  id: string;
  status: { state: string; message?: string };
  artifacts: Array<{ artifact_id: string; description?: string; parts: Array<{ url?: string; raw?: string; filename: string; media_type: string }> }>;
  history?: Array<{ message_id: string; parts: Array<{ text?: string }> ; metadata?: Record<string, unknown> }>;
  metadata?: {
    marketplace?: { state: string; acceptedAt?: string };
    publishedDeliverables?: PublishedDeliverable[];
    failedDeliverables?: number;
    [key: string]: unknown;
  };
};

type A2AResponse =
  | { task?: TaskSnapshot }
  | { status_update?: { task_id: string; status: { state: string; message?: string } } }
  | { artifact_update?: { task_id: string; artifact: { artifact_id: string; parts: Array<{ url?: string; raw?: string; filename: string; media_type: string }> } } }
  | { message?: { task_id: string; metadata?: { intent?: string; delivery?: PublishedDeliverable & { task_id: string } }; parts: Array<{ text?: string }> } };

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

async function post(baseUrl: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function collectEvents(response: Response): Promise<A2AResponse[]> {
  if (!response.body) throw new Error("No response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: A2AResponse[] = [];
  const terminalStates = new Set(["completed", "failed", "canceled", "rejected"]);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
      if (!line) continue;
      const event = JSON.parse(line.slice(5).trim()) as A2AResponse;
      events.push(event);
      if ("task" in event && event.task && terminalStates.has(event.task.status.state)) {
        return events;
      }
    }
  }
  return events;
}

function hasTaskEvent(event: A2AResponse): event is { task: TaskSnapshot } {
  return "task" in event && Boolean(event.task);
}

async function collectUntilDeliver(response: Response, abort: AbortController): Promise<A2AResponse[]> {
  if (!response.body) throw new Error("No response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: A2AResponse[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
      if (!line) continue;
      const event = JSON.parse(line.slice(5).trim()) as A2AResponse;
      events.push(event);
      if ("message" in event && event.message?.metadata?.intent === "deliver") {
        abort.abort();
        return events;
      }
    }
  }
  return events;
}

async function waitForCompletedTask(baseUrl: string, taskId: string): Promise<TaskSnapshot> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const response = await fetch(`${baseUrl}/tasks/${taskId}`);
    if (response.ok) {
      const task = (await response.json()) as TaskSnapshot;
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
    const task = await waitForCompletedTask(baseUrl, taskId);
    assert.equal(task.artifacts.length, 1);
    assert.ok(task.artifacts[0].parts[0].url);
    assert.equal(task.metadata?.marketplace?.state, "accepted");
    assert.equal(task.metadata?.publishedDeliverables?.length, 1);
    assert.ok(task.metadata?.publishedDeliverables?.[0].url);
    assert.equal(task.history?.some((message) => message.metadata?.intent === "deliver"), true);

    const artifactId = task.artifacts[0].artifact_id;
    const artifactResponse = await fetch(`${baseUrl}/tasks/${taskId}/artifacts/${artifactId}`);
    assert.equal(artifactResponse.status, 200);
    assert.ok((artifactResponse.headers.get("content-type") ?? "").includes("presentation"));
    assert.equal(Buffer.from(await artifactResponse.arrayBuffer()).toString("utf8"), "pptx-bytes");
  });
});

test("streams progress, delivery, and completion in order", async () => {
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
    const controller = new AbortController();
    const response = await post(baseUrl, "/message:stream", {
      message: {
        messageId: "msg-1",
        role: "ROLE_USER",
        parts: [{ text: "Prepare a Q4 board pack for our leadership meeting." }],
        metadata: { workspaceContext: workspace },
      },
      configuration: { returnImmediately: true },
      metadata: { workspaceContext: workspace },
    }, controller.signal);
    assert.equal(response.status, 200);

    const events = await collectUntilDeliver(response, controller);
    const statusMessages = events.flatMap((event) => "status_update" in event && event.status_update
      ? [event.status_update.status.message ?? ""]
      : []);
    assert.equal(statusMessages.some((message) => message.includes("Accepted")), true);
    assert.equal(statusMessages.some((message) => message.includes("ETA")), true);

    const artifactIndex = events.findIndex((event) => "artifact_update" in event);
    const deliverIndex = events.findIndex((event) => "message" in event && event.message?.metadata?.intent === "deliver");
    assert.ok(artifactIndex >= 0);
    assert.ok(deliverIndex > artifactIndex);

    const taskEvent = events.find(hasTaskEvent);
    assert.ok(taskEvent);
    const completedTask = await waitForCompletedTask(baseUrl, taskEvent.task.id);
    assert.equal(completedTask.status.state, "completed");
    assert.equal(completedTask.metadata?.publishedDeliverables?.length, 1);
    assert.equal(completedTask.history?.some((message) => message.metadata?.intent === "deliver"), true);
  });
});

test("posts a decision card when the plan still needs input", async () => {
  let planCalls = 0;
  let draftCalls = 0;
  const planWithInputs: PackagePlan = {
    ...plan,
    brief: {
      ...plan.brief,
      openInputs: ["Needs your input: GridLink team", "Needs your input: GridLink numbers"],
    },
  };

  async function waitForInputRequired(baseUrl: string, taskId: string): Promise<TaskSnapshot> {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const response = await fetch(`${baseUrl}/tasks/${taskId}`);
      if (response.ok) {
        const task = await response.json() as TaskSnapshot;
        if (task.status.state === "input-required") return task;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Task did not pause for input in time.");
  }

  await withServer(createA2ARouter({ heartbeatMs: 5, taskTtlMs: 60_000 }, {
    createPlan: async () => {
      planCalls += 1;
      return planCalls === 1 ? planWithInputs : plan;
    },
    createDraft: async () => {
      draftCalls += 1;
      return draft;
    },
    renderFileForDraft: async () => ({
      bytes: Buffer.from("pdf-bytes"),
      ext: "pdf",
      mime: "application/pdf",
      filename: "decision-card.pdf",
    }),
  }), async (baseUrl) => {
    const response = await post(baseUrl, "/message:send", {
      message: {
        messageId: "msg-2",
        role: "ROLE_USER",
        parts: [{ text: "Prepare a GridLink plan." }],
        metadata: { workspaceContext: workspace },
      },
      configuration: { returnImmediately: true },
      metadata: { workspaceContext: workspace },
    });
    assert.equal(response.status, 200);

    const sent = await response.json() as { task: { id: string; status: { state: string } } };
    assert.equal(["submitted", "working"].includes(sent.task.status.state), true);

    const inputRequiredTask = await waitForInputRequired(baseUrl, sent.task.id);
    assert.equal(inputRequiredTask.artifacts.length, 1);
    assert.equal(inputRequiredTask.artifacts[0].description, "Decision card for missing details");
    assert.equal(inputRequiredTask.metadata?.publishedDeliverables?.length, 1);
    assert.equal(inputRequiredTask.history?.some((message) => message.metadata?.intent === "deliver"), true);
    assert.equal(draftCalls, 0);

    const followUpResponse = await post(baseUrl, "/message:send", {
      message: {
        messageId: "msg-3",
        taskId: sent.task.id,
        role: "ROLE_USER",
        parts: [{ text: "GridLink is the infrastructure team and the numbers are current." }],
        metadata: { workspaceContext: workspace },
      },
      configuration: { returnImmediately: true },
      metadata: { workspaceContext: workspace },
    });
    assert.equal(followUpResponse.status, 200);
    const resumed = await followUpResponse.json() as { task: { id: string } };
    assert.equal(resumed.task.id, sent.task.id);

    const completedTask = await waitForCompletedTask(baseUrl, sent.task.id);
    assert.equal(completedTask.status.state, "completed");
    assert.equal(completedTask.artifacts.filter((item) => item.description === "Decision card for missing details").length, 1);
    assert.equal(completedTask.metadata?.publishedDeliverables?.length, 2);
    assert.equal(completedTask.history?.filter((message) => message.metadata?.intent === "deliver").length, 2);
    assert.equal(planCalls, 2);
    assert.equal(draftCalls, 1);
  });
});
