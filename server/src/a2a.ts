import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { buildArtifactDescriptor, renderFileForDraft, safeFilename } from "./artifacts.js";
import { createDraft, createPlan } from "./workflows.js";
import { coerceWorkspaceContext } from "./workspace.js";
import type { AssetDraft, WorkspaceContext } from "./types.js";

const DEFAULT_WORKSPACE: WorkspaceContext = {
  organizationName: "Marketplace request",
  organizationDescription: "No organization context was supplied.",
  workspacePurpose: "Create useful professional work outputs from the supplied request.",
};

const DEFAULT_TASK_TTL_MS = 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 12 * 1000;
// Records hold their rendered artifacts as in-memory buffers, so the store is
// capped as well as expiry-swept. Sized for a small instance.
const MAX_TRACKED_TASKS = 200;
const TERMINAL_STATES = new Set<TaskState>(["completed", "failed", "canceled", "rejected"]);

type TaskState = "submitted" | "working" | "completed" | "failed" | "canceled" | "rejected" | "input-required" | "auth-required";

type A2APart = {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  filename?: string;
  media_type?: string;
};

type A2AMessage = {
  message_id: string;
  context_id?: string;
  task_id?: string;
  role: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  reference_task_ids?: string[];
};

type A2ATaskStatus = {
  state: TaskState;
  message?: string;
  timestamp?: string;
};

type A2AArtifact = {
  artifact_id: string;
  name: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
};

type A2ATask = {
  id: string;
  context_id: string;
  status: A2ATaskStatus;
  artifacts: A2AArtifact[];
  history: A2AMessage[];
  metadata?: Record<string, unknown>;
};

type StatusUpdateEvent = {
  task_id: string;
  context_id: string;
  status: A2ATaskStatus;
};

type ArtifactUpdateEvent = {
  task_id: string;
  context_id: string;
  artifact: A2AArtifact;
};

type StreamResponse = {
  task?: A2ATask;
  message?: A2AMessage;
  status_update?: StatusUpdateEvent;
  artifact_update?: ArtifactUpdateEvent;
};

type FileRecord = {
  bytes: Buffer;
  mime: string;
  filename: string;
};

type TaskRecord = {
  task: A2ATask;
  files: Map<string, FileRecord>;
  subscribers: Set<(event: StreamResponse) => void>;
  processing: Promise<void> | null;
  terminal: boolean;
  baseUrl: string;
  expiresAt: number;
};

type A2AOperations = {
  createPlan: typeof createPlan;
  createDraft: typeof createDraft;
  renderFileForDraft: typeof renderFileForDraft;
};

type A2ARouterConfig = {
  taskTtlMs: number;
  heartbeatMs: number;
};

type TaskInput = {
  request: string;
  workspaceContext: WorkspaceContext;
  openInputs: string[];
};

const MESSAGE_SCHEMA = z.object({
  messageId: z.string().optional(),
  message_id: z.string().optional(),
  contextId: z.string().optional(),
  context_id: z.string().optional(),
  taskId: z.string().optional(),
  task_id: z.string().optional(),
  role: z.string(),
  parts: z.array(z.object({
    text: z.string().optional(),
    raw: z.string().optional(),
    url: z.string().optional(),
    data: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    filename: z.string().optional(),
    media_type: z.string().optional(),
  }).passthrough()).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
  reference_task_ids: z.array(z.string()).optional(),
}).passthrough();

const SEND_REQUEST_SCHEMA = z.object({
  message: MESSAGE_SCHEMA,
  configuration: z.object({
    acceptedOutputModes: z.array(z.string()).optional(),
    historyLength: z.number().int().positive().optional(),
    returnImmediately: z.boolean().optional(),
    taskPushNotificationConfig: z.unknown().optional(),
  }).passthrough().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function toIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function normalizeMessage(raw: z.infer<typeof MESSAGE_SCHEMA>): A2AMessage {
  const messageId = asString(raw.messageId ?? raw.message_id, 120) || crypto.randomUUID();
  const contextId = asString(raw.contextId ?? raw.context_id, 120) || undefined;
  const taskId = asString(raw.taskId ?? raw.task_id, 120) || undefined;
  const referenceTaskIds = raw.referenceTaskIds ?? raw.reference_task_ids ?? [];
  return {
    message_id: messageId,
    context_id: contextId,
    task_id: taskId,
    role: asString(raw.role, 40) || "user",
    parts: raw.parts.map((part) => ({
      text: typeof part.text === "string" ? part.text : undefined,
      raw: typeof part.raw === "string" ? part.raw : undefined,
      url: typeof part.url === "string" ? part.url : undefined,
      data: part.data,
      metadata: part.metadata,
      filename: typeof part.filename === "string" ? part.filename : undefined,
      media_type: typeof part.media_type === "string" ? part.media_type : undefined,
    })),
    metadata: raw.metadata as Record<string, unknown> | undefined,
    extensions: raw.extensions,
    reference_task_ids: referenceTaskIds,
  };
}

function messageText(message: A2AMessage): string {
  const chunks = message.parts.flatMap((part) => {
    if (typeof part.text === "string" && part.text.trim()) return [part.text.trim()];
    if (typeof part.raw === "string" && part.raw.trim()) return [part.raw.trim()];
    if (part.data === undefined) return [];
    if (typeof part.data === "string") return [part.data.trim()];
    try {
      return [JSON.stringify(part.data)];
    } catch {
      return [];
    }
  });
  return chunks.join("\n\n").trim();
}

function workspaceFromMetadata(metadata: Record<string, unknown> | undefined): WorkspaceContext {
  if (!metadata) return DEFAULT_WORKSPACE;
  const parsed = coerceWorkspaceContext(metadata.workspaceContext ?? metadata.workspace_context);
  return parsed ?? DEFAULT_WORKSPACE;
}

function openInputsFromMetadata(metadata: Record<string, unknown> | undefined): string[] {
  const value = metadata?.openInputs ?? metadata?.open_inputs;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function cloneTask(task: A2ATask): A2ATask {
  return structuredClone(task);
}

function cloneArtifact(artifact: A2AArtifact): A2AArtifact {
  return structuredClone(artifact);
}

type PublishedDeliverable = {
  artifact_id: string;
  name: string;
  description?: string;
  filename: string;
  media_type: string;
  byteLength: number;
  url?: string;
};

function taskMessage(task: TaskRecord, text: string, metadata?: Record<string, unknown>): A2AMessage {
  return {
    message_id: crypto.randomUUID(),
    context_id: task.task.context_id,
    task_id: task.task.id,
    role: "agent",
    parts: [{ text }],
    ...(metadata ? { metadata } : {}),
  };
}

function publishedDeliverable(artifact: A2AArtifact): PublishedDeliverable {
  const part = artifact.parts[0] ?? {};
  return {
    artifact_id: artifact.artifact_id,
    name: artifact.name,
    description: artifact.description,
    filename: typeof part.filename === "string" ? part.filename : artifact.name,
    media_type: typeof part.media_type === "string" ? part.media_type : "application/octet-stream",
    byteLength: Number(artifact.metadata?.byteLength ?? 0),
    url: typeof part.url === "string" ? part.url : undefined,
  };
}

function deliveryMessage(task: TaskRecord, artifact: A2AArtifact): A2AMessage {
  const deliverable = publishedDeliverable(artifact);
  return taskMessage(
    task,
    `[intent:deliver] task ${task.task.id} published ${deliverable.artifact_id} (${deliverable.filename}, ${deliverable.media_type}, ${deliverable.byteLength} bytes) ${deliverable.url ?? ""}`.trim(),
    { intent: "deliver", delivery: { task_id: task.task.id, ...deliverable } },
  );
}

function etaMessage(totalAssets: number, publishedAssets: number): string {
  if (totalAssets <= 0) return "No deliverables are planned yet. ETA: finishing up.";
  const remaining = Math.max(totalAssets - publishedAssets, 0);
  const eta = remaining <= 0 ? "finishing up" : remaining === 1 ? "about one more deliverable" : remaining <= 3 ? "a few more deliverables" : "several more deliverables";
  return `Published ${publishedAssets}/${totalAssets} deliverables. ETA: ${eta}.`;
}

class TaskStore {
  private tasks = new Map<string, TaskRecord>();

  constructor(private readonly config: A2ARouterConfig) {
    const interval = Math.max(30_000, Math.min(config.taskTtlMs / 2, 5 * 60 * 1000));
    setInterval(() => this.pruneExpired(), interval).unref();
  }

  get(taskId: string): TaskRecord | null {
    this.pruneExpired();
    return this.tasks.get(taskId) ?? null;
  }

  create(message: A2AMessage, workspaceContext: WorkspaceContext, openInputs: string[], baseUrl: string): TaskRecord {
    const taskId = message.task_id || crypto.randomUUID();
    const contextId = message.context_id || crypto.randomUUID();
    const now = Date.now();
    const record: TaskRecord = {
      task: {
        id: taskId,
        context_id: contextId,
        status: { state: "submitted", timestamp: toIso(now) },
        artifacts: [],
        history: [{ ...message, context_id: contextId, task_id: taskId }],
        metadata: {
          request: messageText(message),
          workspaceContext,
          openInputs,
          baseUrl,
          marketplace: {
            state: "accepted",
            acceptedAt: toIso(now),
          },
          publishedDeliverables: [] as PublishedDeliverable[],
        },
      },
      files: new Map(),
      subscribers: new Set(),
      processing: null,
      terminal: false,
      baseUrl,
      expiresAt: now + this.config.taskTtlMs,
    };
    this.tasks.set(taskId, record);
    return record;
  }

  subscribe(taskId: string, listener: (event: StreamResponse) => void): () => void {
    const record = this.get(taskId);
    if (!record) return () => undefined;
    record.subscribers.add(listener);
    listener({ task: cloneTask(record.task) });
    return () => {
      record.subscribers.delete(listener);
    };
  }

  taskUrl(taskId: string): string {
    return `${this.baseUrlFor(taskId)}/tasks/${encodeURIComponent(taskId)}`;
  }

  artifactUrl(taskId: string, artifactId: string): string {
    const baseUrl = this.tasks.get(taskId)?.baseUrl ?? "";
    return `${baseUrl}/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`;
  }

  addStatus(task: TaskRecord, state: TaskState, message?: string): void {
    task.task.status = { state, message, timestamp: toIso() };
    task.expiresAt = Date.now() + this.config.taskTtlMs;
    this.broadcast(task, { status_update: { task_id: task.task.id, context_id: task.task.context_id, status: cloneTask(task.task).status } });
  }

  addArtifact(
    task: TaskRecord,
    draft: AssetDraft,
    rendered: Awaited<ReturnType<A2AOperations["renderFileForDraft"]>>,
    options: { description?: string } = {},
  ): void {
    const base = safeFilename(draft.title) || draft.kind;
    const artifactId = `${task.task.id}-${base}-${task.task.artifacts.length + 1}`;
    const artifact = buildArtifactDescriptor(draft, rendered, {
      artifactId,
      url: this.artifactUrl(task.task.id, artifactId),
      description: options.description ?? `${draft.kind} deliverable for ${draft.title}`,
    });
    task.task.artifacts = [...task.task.artifacts, artifact];
    task.task.metadata = {
      ...(task.task.metadata ?? {}),
      publishedDeliverables: task.task.artifacts.map((item) => publishedDeliverable(item)),
    };
    task.files.set(artifactId, { bytes: rendered.bytes, mime: rendered.mime, filename: rendered.filename });
    this.broadcast(task, {
      artifact_update: {
        task_id: task.task.id,
        context_id: task.task.context_id,
        artifact: cloneArtifact(artifact),
      },
    });
    const delivery = deliveryMessage(task, artifact);
    task.task.history = [...task.task.history, delivery];
    this.broadcast(task, { message: delivery });
  }

  complete(task: TaskRecord, state: TaskState, message: string): void {
    task.terminal = true;
    this.addStatus(task, state, message);
    task.task.history = [...task.task.history, taskMessage(task, message)];
    this.broadcast(task, { task: cloneTask(task.task) });
  }

  fail(task: TaskRecord, message: string): void {
    this.complete(task, "failed", message);
  }

  broadcast(task: TaskRecord, event: StreamResponse): void {
    if (!task.subscribers.size) return;
    // One clone for the whole fan-out: each listener serialises the event
    // immediately, so no listener can observe another's copy.
    const payload = structuredClone(event);
    for (const listener of task.subscribers) listener(payload);
  }

  ensureProcessing(task: TaskRecord, run: () => Promise<void>): Promise<void> {
    if (task.processing) return task.processing;
    task.processing = run().finally(() => {
      task.processing = null;
      task.expiresAt = Date.now() + this.config.taskTtlMs;
    });
    return task.processing;
  }

  getArtifact(taskId: string, artifactId: string): FileRecord | null {
    this.pruneExpired();
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return task.files.get(artifactId) ?? null;
  }

  private baseUrlFor(taskId: string): string {
    const task = this.tasks.get(taskId);
    return task?.baseUrl ?? "";
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [taskId, task] of this.tasks) {
      // Work in flight is never dropped. Everything else goes on expiry, including
      // a task parked in "input-required" that no caller ever answered — those are
      // not terminal, so a terminal-only sweep would retain them (and their
      // in-memory artifact buffers) for the life of the process.
      if (task.processing) continue;
      if (task.expiresAt > now) continue;
      task.subscribers.clear();
      task.files.clear();
      this.tasks.delete(taskId);
    }
    // Backstop for a burst that outruns the TTL: drop the oldest records first so
    // a flood of new tasks cannot grow the store without bound.
    if (this.tasks.size <= MAX_TRACKED_TASKS) return;
    const byAge = [...this.tasks.entries()]
      .filter(([, task]) => !task.processing)
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
    for (const [taskId, task] of byAge) {
      if (this.tasks.size <= MAX_TRACKED_TASKS) break;
      task.subscribers.clear();
      task.files.clear();
      this.tasks.delete(taskId);
    }
  }
}

async function withHeartbeat<T>(heartbeatMs: number, send: (message: string) => void, run: () => Promise<T>): Promise<T> {
  let done = false;
  const timer = setInterval(() => {
    if (!done) send("Still working on the package.");
  }, heartbeatMs);
  try {
    return await run();
  } finally {
    done = true;
    clearInterval(timer);
  }
}

function streamEvent(res: express.Response, event: StreamResponse): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function toTaskResponse(record: TaskRecord): A2ATask {
  return cloneTask(record.task);
}

function defaultRouterConfig(config: Partial<A2ARouterConfig>): A2ARouterConfig {
  return {
    taskTtlMs: config.taskTtlMs ?? DEFAULT_TASK_TTL_MS,
    heartbeatMs: config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
  };
}

function defaultOperations(operations: Partial<A2AOperations>): A2AOperations {
  return {
    createPlan: operations.createPlan ?? createPlan,
    createDraft: operations.createDraft ?? createDraft,
    renderFileForDraft: operations.renderFileForDraft ?? renderFileForDraft,
  };
}

function createRouter(config: A2ARouterConfig, operations: A2AOperations): express.Router {
  const router = express.Router();
  const store = new TaskStore(config);

  const runTask = async (record: TaskRecord, input: TaskInput): Promise<void> => {
    try {
      store.addStatus(record, "working", "Planning the package.");
      const plan = await withHeartbeat(config.heartbeatMs, (message) => store.addStatus(record, "working", message), () => operations.createPlan({
        request: input.request,
        workspaceContext: input.workspaceContext,
        openInputs: input.openInputs,
      }));

      const pendingInputs = [...new Set(plan.brief.openInputs)].filter(Boolean);
      record.task.metadata = {
        ...(record.task.metadata ?? {}),
        packageName: plan.packageName,
        packageTitle: plan.packageTitle,
        reply: plan.reply,
        openInputs: pendingInputs,
        assetCount: plan.assets.length,
      };

      store.addStatus(record, "working", etaMessage(plan.assets.length, 0));

      if (pendingInputs.length > 0) {
        store.addStatus(record, "input-required", `Decision card posted. Waiting on ${pendingInputs.length} missing detail${pendingInputs.length === 1 ? "" : "s"}.`);
        const decisionCard: AssetDraft = {
          kind: "document",
          title: `${plan.packageTitle} decision card`,
          blurb: plan.reply || "I need these details before I can finish the package.",
          sections: [
            { heading: "Details to confirm", body: pendingInputs },
            { heading: "Next step", body: ["Reply with the missing details and I will continue."] },
          ],
          metadata: {
            evidenceIds: [],
            assumptions: [],
            gaps: pendingInputs,
            quality: [],
            revision: 1,
          },
        };
        const rendered = await operations.renderFileForDraft(decisionCard);
        store.addArtifact(record, decisionCard, rendered, { description: "Decision card for missing details" });
        return;
      }

      store.addStatus(record, "working", `Drafting ${plan.assets.length} deliverable${plan.assets.length === 1 ? "" : "s"}.`);

      let failures = 0;
      for (const asset of plan.assets) {
        try {
          const draft = await withHeartbeat(config.heartbeatMs, (message) => store.addStatus(record, "working", message), async () => {
            store.addStatus(record, "working", `Drafting ${asset.title}.`);
            return operations.createDraft({
              request: input.request,
              workspaceContext: input.workspaceContext,
              openInputs: input.openInputs,
              assetPlan: asset,
              brief: plan.brief,
              onStage: (stage) => {
                if (stage === "revising") store.addStatus(record, "working", `Revising ${asset.title}.`);
                else store.addStatus(record, "working", `Verifying ${asset.title}.`);
              },
            });
          });

          const rendered = await operations.renderFileForDraft(draft);
          store.addArtifact(record, draft, rendered);
        } catch (error) {
          failures += 1;
          const message = error instanceof Error ? error.message : `Drafting ${asset.title} failed.`;
          store.addStatus(record, "working", message);
        }

        store.addStatus(record, "working", etaMessage(plan.assets.length, record.task.artifacts.length + failures));
      }

      const publishedCount = record.task.artifacts.length;
      if (publishedCount === 0) {
        store.fail(record, "No deliverables were produced.");
        return;
      }

      record.task.metadata = {
        ...(record.task.metadata ?? {}),
        failedDeliverables: failures,
        publishedDeliverables: record.task.artifacts.map((item) => publishedDeliverable(item)),
      };

      const availability = publishedCount === 1
        ? "The file is available through the artifact URL."
        : "Files are available through the artifact URLs.";
      const summary = failures > 0
        ? `Published ${publishedCount} deliverable${publishedCount === 1 ? "" : "s"} with ${failures} failed deliverable${failures === 1 ? "" : "s"}. ${availability}`
        : `Published ${publishedCount} deliverable${publishedCount === 1 ? "" : "s"}. ${availability}`;
      store.complete(record, "completed", summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task processing failed.";
      store.fail(record, message);
    }
  };

  const sendHandler = async (req: express.Request, res: express.Response) => {
    const parsed = SEND_REQUEST_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.issues.map((issue) => ({ path: issue.path.join(".") || "body", message: issue.message })) });
    }

    const message = normalizeMessage(parsed.data.message);
    const request = messageText(message);
    if (!request) return res.status(400).json({ error: "Message text is required." });

    const workspaceContext = workspaceFromMetadata(parsed.data.metadata ?? parsed.data.message.metadata);
    const openInputs = openInputsFromMetadata(parsed.data.metadata ?? parsed.data.message.metadata);
    const existing = message.task_id ? store.get(message.task_id) : null;
    if (existing) {
      if (existing.task.status.state === "input-required") {
        const metadata = existing.task.metadata as Record<string, unknown> | undefined;
        const priorRequest = asString(metadata?.request, 6000);
        const combinedRequest = priorRequest ? `${priorRequest}\n\nFollow-up details:\n${request}` : request;
        existing.task.metadata = { ...(metadata ?? {}), request: combinedRequest };
        existing.task.history = [...existing.task.history, { ...message, context_id: existing.task.context_id, task_id: existing.task.id }];
        void store.ensureProcessing(existing, () => runTask(existing, { request: combinedRequest, workspaceContext: workspaceFromMetadata(metadata), openInputs: [] }));
      }
      return res.json({ task: toTaskResponse(existing) });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const record = store.create(message, workspaceContext, openInputs, baseUrl);
    store.addStatus(record, "working", "Accepted. Planning the package.");
    void store.ensureProcessing(record, () => runTask(record, { request, workspaceContext, openInputs }));
    return res.json({ task: toTaskResponse(record) });
  };

  const streamHandler = async (req: express.Request, res: express.Response) => {
    const parsed = SEND_REQUEST_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.issues.map((issue) => ({ path: issue.path.join(".") || "body", message: issue.message })) });
    }

    const message = normalizeMessage(parsed.data.message);
    let request = messageText(message);
    if (!request) return res.status(400).json({ error: "Message text is required." });

    let workspaceContext = workspaceFromMetadata(parsed.data.metadata ?? parsed.data.message.metadata);
    let openInputs = openInputsFromMetadata(parsed.data.metadata ?? parsed.data.message.metadata);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const existing = message.task_id ? store.get(message.task_id) : null;
    const freshTask = !existing;
    const record = existing ?? store.create(message, workspaceContext, openInputs, baseUrl);
    if (record.task.status.state === "input-required") {
      const metadata = record.task.metadata as Record<string, unknown> | undefined;
      const priorRequest = asString(metadata?.request, 6000);
      const nextRequest = priorRequest ? `${priorRequest}\n\nFollow-up details:\n${request}` : request;
      request = nextRequest;
      workspaceContext = workspaceFromMetadata(metadata);
      openInputs = [];
      record.task.metadata = { ...(metadata ?? {}), request: nextRequest };
      record.task.history = [...record.task.history, { ...message, context_id: record.task.context_id, task_id: record.task.id }];
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let unsubscribe: () => void = () => undefined;
    unsubscribe = store.subscribe(record.task.id, (event) => {
      streamEvent(res, event);
      const state = event.task?.status.state;
      if (event.task && state && TERMINAL_STATES.has(state)) {
        unsubscribe();
        res.end();
      }
    });
    const cleanup = () => unsubscribe();
    // "close" on the response covers both a finished stream and a client that
    // hung up; the request's "aborted" event is deprecated.
    res.once("close", cleanup);

    if (freshTask) {
      store.addStatus(record, "working", "Accepted. Planning the package.");
    }

    if (!record.processing && !record.terminal) {
      void store.ensureProcessing(record, () => runTask(record, { request, workspaceContext, openInputs }));
    }
  };

  router.post(/^\/message:send$/, sendHandler);
  router.post(/^\/[^/]+\/message:send$/, sendHandler);
  router.post(/^\/message:stream$/, streamHandler);
  router.post(/^\/[^/]+\/message:stream$/, streamHandler);

  router.get("/tasks/:taskId", (req, res) => {
    const record = store.get(req.params.taskId);
    if (!record) return res.status(404).json({ error: "Task not found" });
    return res.json(toTaskResponse(record));
  });

  router.get("/:tenant/tasks/:taskId", (req, res) => {
    const record = store.get(req.params.taskId);
    if (!record) return res.status(404).json({ error: "Task not found" });
    return res.json(toTaskResponse(record));
  });

  router.get("/tasks/:taskId/artifacts/:artifactId", (req, res) => {
    const file = store.getArtifact(req.params.taskId, req.params.artifactId);
    if (!file) return res.status(404).json({ error: "Artifact not found" });
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    return res.send(file.bytes);
  });

  router.get("/:tenant/tasks/:taskId/artifacts/:artifactId", (req, res) => {
    const file = store.getArtifact(req.params.taskId, req.params.artifactId);
    if (!file) return res.status(404).json({ error: "Artifact not found" });
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    return res.send(file.bytes);
  });

  return router;
}

export function createA2ARouter(config: Partial<A2ARouterConfig> = {}, operations: Partial<A2AOperations> = {}): express.Router {
  return createRouter(defaultRouterConfig(config), defaultOperations(operations));
}
