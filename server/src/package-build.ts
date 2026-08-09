import JSZip from "jszip";
import { safeFilename } from "./artifacts.js";

export type PackageEntry = {
  title: string;
  ext: string;
  bytes: Buffer;
  /** Details the draft could not resolve, surfaced in the index rather than guessed at. */
  gaps?: string[];
};

export type PackageZip = {
  bytes: Buffer;
  filename: string;
  /** In-zip names, in order, for callers that want to show what was delivered. */
  names: string[];
  gaps: string[];
};

/**
 * Assemble rendered files into one download.
 *
 * Takes bytes rather than drafts on purpose: the paid marketplace path has
 * already rendered every asset by the time it gets here, and rendering a second
 * time would double the CPU on a single-core instance for an identical result.
 */
export async function buildPackageZip(packageName: string, entries: PackageEntry[]): Promise<PackageZip> {
  const zip = new JSZip();
  const names: string[] = [];
  const gaps = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const safe = safeFilename(entry.title).slice(0, 60) || "output";
    const name = `${String(index + 1).padStart(2, "0")} ${safe}.${entry.ext}`;
    zip.file(name, entry.bytes);
    names.push(name);
    entry.gaps?.forEach((gap) => gaps.add(gap));
  }

  const notes = gaps.size
    ? `\n\n## Details to confirm\n\n${[...gaps].map((gap) => `- ${gap}`).join("\n")}\n\nThis package is a draft until these details are confirmed.`
    : "";
  zip.file("00 INDEX.md", `# ${packageName}\n\n${entries.length} outputs assembled by Werk.\n\n${names.map((name) => `- ${name}`).join("\n")}${notes}\n`);

  return {
    bytes: await zip.generateAsync({ type: "nodebuffer" }),
    filename: `${safeFilename(packageName, "package").slice(0, 60) || "package"}.zip`,
    names,
    gaps: [...gaps],
  };
}
