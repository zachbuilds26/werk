import type { WorkspaceContext } from "./types.js";

const WORKSPACE_LABEL = "Workspace context:";

function asString(v: unknown, max = 400): string {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.slice(0, max);
}

export function coerceWorkspaceContext(raw: unknown): WorkspaceContext | null {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const organizationName = asString(obj.organizationName, 120).trim();
  const organizationDescription = asString(obj.organizationDescription, 240).trim();
  const workspacePurpose = asString(obj.workspacePurpose, 240).trim();

  if (!organizationName || !organizationDescription || !workspacePurpose) return null;

  const workspace: WorkspaceContext = {
    organizationName,
    organizationDescription,
    workspacePurpose,
  };

  const defaultAudience = asString(obj.defaultAudience, 160).trim();
  if (defaultAudience) workspace.defaultAudience = defaultAudience;

  const toneAndConstraints = asString(obj.toneAndConstraints, 240).trim();
  if (toneAndConstraints) workspace.toneAndConstraints = toneAndConstraints;

  const additionalContext = asString(obj.additionalContext, 320).trim();
  if (additionalContext) workspace.additionalContext = additionalContext;

  return workspace;
}

export function workspaceContextErrorMessage(): string {
  return "workspaceContext.organizationName, organizationDescription, and workspacePurpose are required";
}

export function buildWorkspaceContextBlock(workspace: WorkspaceContext): string {
  const lines = [
    `Company or team: ${workspace.organizationName.trim()}`,
    `What they do: ${workspace.organizationDescription.trim()}`,
    `Workspace purpose: ${workspace.workspacePurpose.trim()}`,
    workspace.defaultAudience?.trim() ? `Default audience: ${workspace.defaultAudience.trim()}` : "",
    workspace.toneAndConstraints?.trim() ? `Tone and constraints: ${workspace.toneAndConstraints.trim()}` : "",
    workspace.additionalContext?.trim() ? `Additional context: ${workspace.additionalContext.trim()}` : "",
  ].filter(Boolean);

  return [WORKSPACE_LABEL, ...lines].join("\n");
}

export function stripWorkspaceContextBlock(request: string): string {
  const trimmed = request.trim();
  if (!trimmed.startsWith(WORKSPACE_LABEL)) return trimmed;

  const body = trimmed.slice(WORKSPACE_LABEL.length).trimStart();
  const separator = body.indexOf("\n\n");
  if (separator === -1) return body.trim();
  return body.slice(separator + 2).trim();
}

export function buildWorkspaceRequest(workspace: WorkspaceContext, request: string): string {
  const body = stripWorkspaceContextBlock(request);
  if (!body) return buildWorkspaceContextBlock(workspace);
  return `${buildWorkspaceContextBlock(workspace)}\n\n${body}`;
}
