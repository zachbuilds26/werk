import type { AssetKind, RenderFormat } from "./types.js";

export interface AssetSpec {
  formats: readonly RenderFormat[];
  minItems: number;
  maxItems: number;
  minimumDetailWords: number;
  promptRequirement: string;
}

// These are depth guardrails, not a reason to manufacture facts. Unknown
// operational fields use the visible "Needs your input: …" convention.
export const ASSET_SPECS: Record<AssetKind, AssetSpec> = {
  deck: { formats: ["md", "pdf", "pptx"], minItems: 7, maxItems: 12, minimumDetailWords: 5, promptRequirement: "7 to 12 useful slides with clear headings and no invented facts." },
  document: { formats: ["md", "pdf"], minItems: 5, maxItems: 8, minimumDetailWords: 14, promptRequirement: "5 to 8 useful sections with clear, complete writing and visible open inputs." },
  sheet: { formats: ["md", "xlsx"], minItems: 8, maxItems: 18, minimumDetailWords: 1, promptRequirement: "5 to 10 columns and 8 to 18 useful rows. Unknown values remain visibly marked." },
  agenda: { formats: ["md", "pdf"], minItems: 5, maxItems: 10, minimumDetailWords: 4, promptRequirement: "5 to 10 sequenced agenda items. Unknown times or people remain visibly marked." },
  actions: { formats: ["md", "pdf"], minItems: 6, maxItems: 12, minimumDetailWords: 5, promptRequirement: "6 to 12 specific tasks. Unknown responsibility or timing remains visibly marked." },
  timeline: { formats: ["md", "pdf"], minItems: 4, maxItems: 8, minimumDetailWords: 14, promptRequirement: "4 to 8 ordered phases. Unknown windows or people remain visibly marked." },
};

export const MAX_PACKAGE_ITEMS = 4;
export const MAX_RENDER_TEXT_LENGTH = 24000;
export const MAX_TABLE_COLUMNS = 10;
export const MAX_TABLE_ROWS = 18;
