import { ASSET_SPECS } from "./asset-specs.js";
import type { AssetDraft, QualityIssue } from "./types.js";

const PLACEHOLDER = /\[(?:metric|segment|date|owner|region|number|plan|actual)\]/i;
const VAGUE = /\b(?:strong sales|in line with expectations|various initiatives|key drivers|drive execution|align team)\b/i;

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

function contentIssues(value: string, path: string, minimumWords: number): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (words(value) < minimumWords) issues.push({ code: "too-short", message: "Add concrete detail.", severity: "error", path });
  if (PLACEHOLDER.test(value)) issues.push({ code: "placeholder", message: "Replace bracketed placeholders with a fact or a labelled assumption.", severity: "error", path });
  if (VAGUE.test(value)) issues.push({ code: "vague-language", message: "Replace vague business filler with evidence, an implication, or a labelled assumption.", severity: "warning", path });
  return issues;
}

export function validateDraftQuality(draft: AssetDraft): QualityIssue[] {
  const spec = ASSET_SPECS[draft.kind];
  const issues = contentIssues(draft.blurb, "blurb", 12);

  switch (draft.kind) {
    case "deck": {
      const slides = draft.slides ?? [];
      if (slides.length < spec.minItems || slides.length > spec.maxItems) {
        issues.push({ code: "slide-count", message: `Use ${spec.minItems} to ${spec.maxItems} slides.`, severity: "error", path: "slides" });
      }
      slides.forEach((slide, index) => {
        if (!slide.eyebrow) issues.push({ code: "missing-eyebrow", message: "Add a section tag.", severity: "error", path: `slides.${index}.eyebrow` });
        issues.push(...contentIssues(slide.title, `slides.${index}.title`, index === 0 ? 2 : 5));
        const minimumBullets = index === 0 ? 1 : 4;
        if (slide.bullets.length < minimumBullets) issues.push({ code: "bullet-count", message: `Add at least ${minimumBullets} bullets.`, severity: "error", path: `slides.${index}.bullets` });
        slide.bullets.forEach((bullet, bulletIndex) => issues.push(...contentIssues(bullet, `slides.${index}.bullets.${bulletIndex}`, spec.minimumDetailWords)));
        if (duplicateText(slide.bullets)) issues.push({ code: "duplicate-bullet", message: "Remove repeated slide bullets.", severity: "error", path: `slides.${index}.bullets` });
      });
      break;
    }
    case "document": {
      const sections = draft.sections ?? [];
      if (sections.length < spec.minItems || sections.length > spec.maxItems) issues.push({ code: "section-count", message: `Use ${spec.minItems} to ${spec.maxItems} sections.`, severity: "error", path: "sections" });
      sections.forEach((section, index) => {
        if (section.body.length < 2) issues.push({ code: "paragraph-count", message: "Add at least two analytical paragraphs.", severity: "error", path: `sections.${index}.body` });
        section.body.forEach((paragraph, paragraphIndex) => issues.push(...contentIssues(paragraph, `sections.${index}.body.${paragraphIndex}`, spec.minimumDetailWords)));
      });
      break;
    }
    case "sheet": {
      const table = draft.table;
      if (!table || table.columns.length < 6 || table.columns.length > 10 || table.rows.length < spec.minItems || table.rows.length > spec.maxItems) {
        issues.push({ code: "table-shape", message: "Use 6 to 10 columns and 15 to 24 complete rows.", severity: "error", path: "table" });
      } else {
        table.rows.forEach((row, index) => {
          if (row.length !== table.columns.length || row.some((cell) => !cell.trim())) issues.push({ code: "incomplete-row", message: "Complete every table cell.", severity: "error", path: `table.rows.${index}` });
        });
      }
      break;
    }
    case "agenda": {
      const items = draft.agenda ?? [];
      if (items.length < spec.minItems || items.length > spec.maxItems) issues.push({ code: "agenda-count", message: `Use ${spec.minItems} to ${spec.maxItems} agenda items.`, severity: "error", path: "agenda" });
      items.forEach((item, index) => {
        if (!item.time || !item.owner) issues.push({ code: "agenda-ownership", message: "Every item needs a time and accountable owner.", severity: "error", path: `agenda.${index}` });
        issues.push(...contentIssues(item.topic, `agenda.${index}.topic`, spec.minimumDetailWords));
      });
      break;
    }
    case "actions": {
      const items = draft.actions ?? [];
      if (items.length < spec.minItems || items.length > spec.maxItems) issues.push({ code: "action-count", message: `Use ${spec.minItems} to ${spec.maxItems} actions.`, severity: "error", path: "actions" });
      items.forEach((item, index) => {
        if (!item.owner || !item.due) issues.push({ code: "action-ownership", message: "Every action needs an owner and due date.", severity: "error", path: `actions.${index}` });
        issues.push(...contentIssues(item.task, `actions.${index}.task`, spec.minimumDetailWords));
      });
      break;
    }
    case "timeline": {
      const phases = draft.timeline ?? [];
      if (phases.length < spec.minItems || phases.length > spec.maxItems) issues.push({ code: "timeline-count", message: `Use ${spec.minItems} to ${spec.maxItems} phases.`, severity: "error", path: "timeline" });
      phases.forEach((phase, index) => {
        if (!phase.window) issues.push({ code: "timeline-window", message: "Every phase needs a time window.", severity: "error", path: `timeline.${index}.window` });
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
