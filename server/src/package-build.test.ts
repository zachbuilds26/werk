import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { buildPackageZip } from "./package-build.js";

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

test("names entries in order and lists them in the index", async () => {
  const zip = await buildPackageZip("Launch package", [
    { title: "Product launch plan", ext: "pdf", bytes: bytes("one") },
    { title: "Launch budget tracker", ext: "xlsx", bytes: bytes("two") },
  ]);

  assert.deepEqual(zip.names, ["01 Product launch plan.pdf", "02 Launch budget tracker.xlsx"]);
  assert.equal(zip.filename, "Launch package.zip");

  const read = await JSZip.loadAsync(zip.bytes);
  assert.deepEqual(Object.keys(read.files).sort(), [
    "00 INDEX.md",
    "01 Product launch plan.pdf",
    "02 Launch budget tracker.xlsx",
  ]);
  const index = await read.file("00 INDEX.md")?.async("string") ?? "";
  assert.match(index, /# Launch package/);
  assert.match(index, /2 outputs assembled by Werk/);
  assert.match(index, /- 01 Product launch plan\.pdf/);
});

test("carries every draft's open inputs into one details-to-confirm list", async () => {
  const zip = await buildPackageZip("Launch package", [
    { title: "Plan", ext: "pdf", bytes: bytes("one"), gaps: ["Audience", "Deadline"] },
    { title: "Tracker", ext: "xlsx", bytes: bytes("two"), gaps: ["Deadline", "Budget"] },
  ]);

  // Deduplicated across assets: a buyer should see one list, not one per file.
  assert.deepEqual(zip.gaps, ["Audience", "Deadline", "Budget"]);

  const read = await JSZip.loadAsync(zip.bytes);
  const index = await read.file("00 INDEX.md")?.async("string") ?? "";
  assert.match(index, /## Details to confirm/);
  assert.match(index, /- Audience/);
  assert.match(index, /draft until these details are confirmed/);
});

test("omits the details section when nothing is open", async () => {
  const zip = await buildPackageZip("Launch package", [{ title: "Plan", ext: "pdf", bytes: bytes("one") }]);
  const read = await JSZip.loadAsync(zip.bytes);
  const index = await read.file("00 INDEX.md")?.async("string") ?? "";

  assert.deepEqual(zip.gaps, []);
  assert.equal(index.includes("Details to confirm"), false);
});

test("falls back to a usable name when a title has no safe characters", async () => {
  const zip = await buildPackageZip("***", [{ title: "///", ext: "pdf", bytes: bytes("one") }]);

  assert.deepEqual(zip.names, ["01 output.pdf"]);
  assert.equal(zip.filename, "package.zip");
});
