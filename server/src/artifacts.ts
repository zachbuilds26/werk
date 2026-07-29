import crypto from "node:crypto";
import { renderDraft } from "./render.js";
import type { AssetDraft, AssetKind, RenderFormat } from "./types.js";

export const RENDER_FORMAT_BY_KIND: Record<AssetKind, RenderFormat> = {
  deck: "pptx",
  document: "pdf",
  sheet: "xlsx",
  agenda: "pdf",
  actions: "pdf",
  timeline: "pdf",
};

export function safeFilename(value: string, fallback = "output"): string {
  const clean = value.replace(/[^a-z0-9\-_ ]/gi, "").trim();
  return clean || fallback;
}

export interface RenderedFile {
  bytes: Buffer;
  ext: RenderFormat;
  mime: string;
  filename: string;
}

export async function renderFileForDraft(draft: AssetDraft): Promise<RenderedFile> {
  const rendered = await renderDraft(draft, RENDER_FORMAT_BY_KIND[draft.kind]);
  return {
    bytes: rendered.bytes,
    ext: rendered.ext as RenderFormat,
    mime: rendered.mime,
    filename: `${safeFilename(draft.title)}.${rendered.ext}`,
  };
}

export type ArtifactPart = {
  filename: string;
  media_type: string;
  raw?: string;
  url?: string;
};

export interface ArtifactDescriptor {
  artifact_id: string;
  name: string;
  description?: string;
  parts: ArtifactPart[];
  metadata?: {
    kind: AssetKind;
    format: RenderFormat;
    byteLength: number;
  };
}

export function buildArtifactDescriptor(
  draft: AssetDraft,
  rendered: RenderedFile,
  options: { artifactId?: string; description?: string; url?: string } = {},
): ArtifactDescriptor {
  return {
    artifact_id: options.artifactId ?? crypto.randomUUID(),
    name: draft.title,
    description: options.description ?? `${draft.kind} deliverable`,
    parts: [{
      filename: rendered.filename,
      media_type: rendered.mime,
      ...(options.url ? { url: options.url } : { raw: rendered.bytes.toString("base64") }),
    }],
    metadata: {
      kind: draft.kind,
      format: rendered.ext,
      byteLength: rendered.bytes.length,
    },
  };
}
