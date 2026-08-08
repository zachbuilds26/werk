import { z } from "zod";
import { ASSET_KINDS } from "./types.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const textList = (maxItems: number, maxLength: number) => z.array(text(maxLength)).max(maxItems);

export const assetKindSchema = z.enum(ASSET_KINDS);
export const renderFormatSchema = z.enum(["md", "pdf", "pptx", "xlsx"]);

export const workspaceContextSchema = z.object({
  organizationName: text(160),
  organizationDescription: text(1200),
  workspacePurpose: text(1200),
  defaultAudience: optionalText(500),
  toneAndConstraints: optionalText(1200),
  additionalContext: optionalText(4000),
}).strict();

export const requestPayloadSchema = z.object({
  request: text(6000),
  workspaceContext: workspaceContextSchema,
  openInputs: textList(12, 280).optional(),
}).strict();

const marketplaceWorkspaceContextSchema = workspaceContextSchema.partial().strict();
const marketplacePlanRequestSchema = z.object({
  operation: z.literal("plan"),
  request: text(6000),
  workspaceContext: marketplaceWorkspaceContextSchema.optional(),
  openInputs: textList(12, 280).optional(),
}).strict();
const marketplaceDraftRequestSchema = z.object({
  operation: z.literal("draft"),
  continuationToken: text(64000),
  assetId: text(80),
}).strict();

export const marketplaceInvocationSchema = z.discriminatedUnion("operation", [
  marketplacePlanRequestSchema,
  marketplaceDraftRequestSchema,
]);

const slideSchema = z.object({
  eyebrow: text(80), title: text(220), bullets: z.array(text(500)).min(1).max(6),
}).strict();
const documentSectionSchema = z.object({
  heading: text(220), body: z.array(text(1400)).min(1).max(3),
}).strict();
const tableSchema = z.object({
  columns: z.array(text(120)).min(1).max(10), rows: z.array(z.array(text(180)).min(1).max(10)).min(1).max(24),
}).strict();
const agendaSchema = z.object({ time: text(80), topic: text(240), owner: text(140) }).strict();
const actionSchema = z.object({ task: text(300), owner: text(140), due: text(120) }).strict();
const timelineSchema = z.object({ phase: text(160), window: text(120), detail: text(900) }).strict();

const qualityIssueSchema = z.object({
  code: text(80), message: text(400), severity: z.enum(["error", "warning"]), path: optionalText(240),
}).strict();

const draftMetadataSchema = z.object({
  evidenceIds: textList(32, 80),
  assumptions: textList(16, 400),
  gaps: textList(16, 400),
  quality: z.array(qualityIssueSchema).max(80),
  revision: z.number().int().min(1).max(50),
}).strict();

export const assetDraftSchema = z.object({
  kind: assetKindSchema,
  title: text(180),
  blurb: text(700),
  slides: z.array(slideSchema).max(18).optional(),
  sections: z.array(documentSectionSchema).max(10).optional(),
  table: tableSchema.optional(),
  agenda: z.array(agendaSchema).max(12).optional(),
  actions: z.array(actionSchema).max(16).optional(),
  timeline: z.array(timelineSchema).max(10).optional(),
  metadata: draftMetadataSchema.optional(),
}).strict();

export const assetPlanSchema = z.object({
  id: text(80), kind: assetKindSchema, title: text(180), summary: text(300), purpose: text(360), audience: text(180), decision: text(320),
  requiredAnalysis: z.array(text(280)).min(1).max(8), acceptanceCriteria: z.array(text(280)).min(1).max(8),
  evidenceIds: textList(24, 80), dependencies: textList(8, 180),
}).strict();

export const packageBriefSchema = z.object({
  objective: text(320), audience: text(180), decision: text(320), timing: text(180),
  knownDetails: textList(16, 280), openInputs: textList(12, 280), sharedTerms: textList(12, 100), consistencyRules: textList(12, 180),
}).strict();

/**
 * Assets a single package may contain. The planner deliberately recommends a
 * small reviewable set, and the API boundary holds the same ceiling so a
 * hand-built plan cannot request more work than the planner would ever produce.
 */
export const MAX_PLAN_ASSETS = 4;

export const packagePlanSchema = z.object({
  packageName: text(80), packageTitle: text(180), reply: text(280), brief: packageBriefSchema,
  assets: z.array(assetPlanSchema).min(1).max(MAX_PLAN_ASSETS),
}).strict();

export const generateRequestSchema = requestPayloadSchema.extend({
  plan: packagePlanSchema.optional(),
}).strict();

export const draftRequestSchema = requestPayloadSchema.extend({
  kind: assetKindSchema,
  title: text(180),
  assetPlan: assetPlanSchema.optional(),
  brief: packageBriefSchema.optional(),
  revisionInstruction: optionalText(1200),
  previousDraft: assetDraftSchema.optional(),
}).strict();

export const renderRequestSchema = z.object({ draft: assetDraftSchema, format: renderFormatSchema }).strict();
export const packageRequestSchema = z.object({
  packageName: text(120),
  items: z.array(z.object({ draft: assetDraftSchema, format: renderFormatSchema }).strict()).min(1).max(MAX_PLAN_ASSETS),
}).strict();

export function validationDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join(".") || "body", message: issue.message }));
}
