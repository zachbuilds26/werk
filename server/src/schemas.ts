import { z } from "zod";
import { ASSET_KINDS } from "./types.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

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
  request: text(12000),
  workspaceContext: workspaceContextSchema,
  assumptionMode: z.enum(["ask", "illustrative"]).optional(),
}).strict();

const slideSchema = z.object({
  eyebrow: text(80),
  title: text(220),
  bullets: z.array(text(500)).min(1).max(6),
}).strict();
const documentSectionSchema = z.object({
  heading: text(220),
  body: z.array(text(1400)).min(1).max(3),
}).strict();
const tableSchema = z.object({
  columns: z.array(text(120)).min(1).max(10),
  rows: z.array(z.array(text(180)).min(1).max(10)).min(1).max(24),
}).strict();
const agendaSchema = z.object({ time: text(48), topic: text(240), owner: text(100) }).strict();
const actionSchema = z.object({ task: text(300), owner: text(100), due: text(80) }).strict();
const timelineSchema = z.object({ phase: text(160), window: text(100), detail: text(900) }).strict();

const qualityIssueSchema = z.object({
  code: text(80),
  message: text(400),
  severity: z.enum(["error", "warning"]),
  path: optionalText(240),
}).strict();

const draftMetadataSchema = z.object({
  evidenceIds: z.array(text(80)).max(32),
  assumptions: z.array(text(400)).max(16),
  gaps: z.array(text(400)).max(16),
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

const assetPlanSchema = z.object({
  id: text(80),
  kind: assetKindSchema,
  title: text(180),
  summary: text(300),
  purpose: text(360),
  audience: text(180),
  decision: text(320),
  requiredAnalysis: z.array(text(280)).min(1).max(8),
  acceptanceCriteria: z.array(text(280)).min(1).max(8),
  evidenceIds: z.array(text(80)).max(24),
  dependencies: z.array(text(180)).max(8),
}).strict();

export const draftRequestSchema = requestPayloadSchema.extend({
  kind: assetKindSchema,
  title: text(180),
  assetPlan: assetPlanSchema.optional(),
  revisionInstruction: optionalText(1200),
  previousDraft: assetDraftSchema.optional(),
}).strict();

export const renderRequestSchema = z.object({
  draft: assetDraftSchema,
  format: renderFormatSchema,
}).strict();

export const packageRequestSchema = z.object({
  packageName: text(120),
  items: z.array(z.object({ draft: assetDraftSchema, format: renderFormatSchema }).strict()).min(1).max(6),
}).strict();

export function validationDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join(".") || "body", message: issue.message }));
}
