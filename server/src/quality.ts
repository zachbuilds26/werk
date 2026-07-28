import { ASSET_SPECS } from "./asset-specs.js";
import type { AssetDraft, QualityIssue } from "./types.js";

const PLACEHOLDER = /\[(?:metric|segment|date|owner|region|number|plan|actual)\]/i;
const VAGUE = /\b(?:strong sales|in line with expectations|various initiatives|key drivers|drive execution|align team)\b/i;
const RETIRED_ILLUSTRATIVE = /figures are illustrative starting points|plausible (?:numbers|figures)|revenue \$\d/i;
const OPEN_INPUT = /^Needs your input:\s*.+/i;

function words(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function duplicateText(values: string[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const normal = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normal) continue;
    if (seen.has(normal)) return true;
    seen.add(normal);
  }
  return false;
}

function isOpenInput(value: string): boolean {
  return OPEN_INPUT.test(value.trim());
}

function contentIssues(value: string, path: string, minimumWords: number): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (isOpenInput(value)) return issues;
  if (words(value) < minimumWords) issues.push({ code: "too-short", message: "Add useful detail or mark the missing input clearly.", severity: "error", path });
  if (PLACEHOLDER.test(value)) issues.push({ code: "placeholder", message: "Replace bracketed placeholders with supplied information or a visible open input.", severity: "error", path });
  if (RETIRED_ILLUSTRATIVE.test(value)) issues.push({ code: "invented-content", message: "Remove invented figures or illustrative-data language. Use supplied facts or mark the input as needed.", severity: "error", path });
  if (VAGUE.test(value)) issues.push({ code: "vague-language", message: "Replace vague business filler with a useful action, implication, or visible open input.", severity: "warning", path });
  return issues;
}

function requiredFieldIssue(value: string, label: string, path: string): QualityIssue[] {
  if (value.trim() || isOpenInput(value)) return [];
  return [{ code: "missing-field", message: `Add ${label} or use “Needs your input: ${label.toLowerCase()}”.`, severity: "error", path }];
}

export function validateDraftQuality(draft: AssetDraft): QualityIssue[] {
  const spec = ASSET_SPECS[draft.kind];
  const issues = contentIssues(draft.blurb, "blurb", 8);

  switch (draft.kind) {
    case "deck": {
      const slides = draft.slides ?? [];
      if (slides.length < spec.minItems || slides.length > spec.maxItems) issues.push({ code: "slide-count", message: `Use ${spec.minItems} to ${spec.maxItems} slides.`, severity: "error", path: "slides" });
      slides.forEach((slide, index) => {
        issues.push(...contentIssues(slide.title, `slides.${index}.title`, 2));
        if (slide.bullets.length < 1) issues.push({ code: "bullet-count", message: "Add at least one useful point.", severity: "error", path: `slides.${index}.bullets` });
        slide.bullets.forEach((bullet, bulletIndex) => issues.push(...contentIssues(bullet, `slides.${index}.bullets.${bulletIndex}`, spec.minimumDetailWords)));
        if (duplicateText(slide.bullets)) issues.push({ code: "duplicate-bullet", message: "Remove repeated slide bullets.", severity: "error", path: `slides.${index}.bullets` });
      });
      break;
    }
    case "document": {
      const sections = draft.sections ?? [];
      if (sections.length < spec.minItems || sections.length > spec.maxItems) issues.push({ code: "section-count", message: `Use ${spec.minItems} to ${spec.maxItems} sections.`, severity: "error", path: "sections" });
      sections.forEach((section, index) => section.body.forEach((paragraph, paragraphIndex) => issues.push(...contentIssues(paragraph, `sections.${index}.body.${paragraphIndex}`, spec.minimumDetailWords))));
      break;
    }
    case "sheet": {
      const table = draft.table;
      if (!table || table.columns.length < 5 || table.columns.length > 10 || table.rows.length < spec.minItems || table.rows.length > spec.maxItems) {
        issues.push({ code: "table-shape", message: "Use 5 to 10 columns and a complete, useful set of rows.", severity: "error", path: "table" });
      } else table.rows.forEach((row, index) => {
        if (row.length !== table.columns.length || row.some((cell) => !cell.trim())) issues.push({ code: "incomplete-row", message: "Complete every table cell or mark the missing input.", severity: "error", path: `table.rows.${index}` });
        row.forEach((cell, cellIndex) => issues.push(...contentIssues(cell, `table.rows.${index}.${cellIndex}`, 1)));
      });
      break;
    }
    case "agenda": {
      const items = draft.agenda ?? [];
      if (items.length < spec.minItems || items.length > spec.maxItems) issues.push({ code: "agenda-count", message: `Use ${spec.minItems} to ${spec.maxItems} agenda items.`, severity: "error", path: "agenda" });
      items.forEach((item, index) => {
        issues.push(...requiredFieldIssue(item.time, "meeting time", `agenda.${index}.time`));
        issues.push(...requiredFieldIssue(item.owner, "responsible person", `agenda.${index}.owner`));
        issues.push(...contentIssues(item.topic, `agenda.${index}.topic`, spec.minimumDetailWords));
      });
      break;
    }
    case "actions": {
      const items = draft.actions ?? [];
      if (items.length < spec.minItems || items.length > spec.maxItems) issues.push({ code: "action-count", message: `Use ${spec.minItems} to ${spec.maxItems} actions.`, severity: "error", path: "actions" });
      items.forEach((item, index) => {
        issues.push(...requiredFieldIssue(item.owner, "responsible person", `actions.${index}.owner`));
        issues.push(...requiredFieldIssue(item.due, "due date", `actions.${index}.due`));
        issues.push(...contentIssues(item.task, `actions.${index}.task`, spec.minimumDetailWords));
      });
      break;
    }
    case "timeline": {
      const phases = draft.timeline ?? [];
      if (phases.length < spec.minItems || phases.length > spec.maxItems) issues.push({ code: "timeline-count", message: `Use ${spec.minItems} to ${spec.maxItems} phases.`, severity: "error", path: "timeline" });
      phases.forEach((phase, index) => {
        issues.push(...requiredFieldIssue(phase.window, "time window", `timeline.${index}.window`));
        issues.push(...contentIssues(phase.detail, `timeline.${index}.detail`, spec.minimumDetailWords));
      });
      break;
    }
  }
  return issues;
}

export function qualityErrors(issues: QualityIssue[]): QualityIssue[] {
  return issues.filter((issue) => issue.severity === "error");
}
