import type { AssetKind, RenderFormat } from "./types.js";

export interface AssetSpec {
  formats: readonly RenderFormat[];
  minItems: number;
  maxItems: number;
  minimumDetailWords: number;
  promptRequirement: string;
}

export const ASSET_SPECS: Record<AssetKind, AssetSpec> = {
  deck: {
    formats: ["md", "pdf", "pptx", "xlsx"],
    minItems: 14,
    maxItems: 18,
    minimumDetailWords: 8,
    promptRequirement: "14 to 18 slides. Every non-title slide has 4 to 6 evidence-backed bullets and a claim headline.",
  },
  document: {
    formats: ["md", "pdf", "pptx", "xlsx"],
    minItems: 8,
    maxItems: 10,
    minimumDetailWords: 24,
    promptRequirement: "8 to 10 sections. Every section has 2 to 3 analytical paragraphs with complete sentences.",
  },
  sheet: {
    formats: ["md", "pdf", "pptx", "xlsx"],
    minItems: 15,
    maxItems: 24,
    minimumDetailWords: 1,
    promptRequirement: "6 to 10 columns and 15 to 24 complete decision-useful rows.",
  },
  agenda: {
    formats: ["md", "pdf", "pptx", "xlsx"],
    minItems: 8,
    maxItems: 12,
    minimumDetailWords: 5,
    promptRequirement: "8 to 12 sequenced agenda items with a time range, decision or output, and accountable owner.",
  },
  actions: {
    formats: ["md", "pdf", "pptx", "xlsx"],
    minItems: 10,
    maxItems: 16,
    minimumDetailWords: 7,
    promptRequirement: "10 to 16 concrete action items with a deliverable, accountable owner, and due date.",
  },
  timeline: {
    formats: ["md", "pdf", "pptx", "xlsx"],
    minItems: 6,
    maxItems: 10,
    minimumDetailWords: 24,
    promptRequirement: "6 to 10 ordered phases with a date range, exit criterion, dependency, and accountable role.",
  },
};

export const MAX_PACKAGE_ITEMS = 6;
export const MAX_RENDER_TEXT_LENGTH = 24000;
export const MAX_TABLE_COLUMNS = 10;
export const MAX_TABLE_ROWS = 24;
