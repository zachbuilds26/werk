import assert from "node:assert/strict";
import { test } from "node:test";
import { PackageStore, type StoredFile } from "./package-store.js";

const file = (name: string): StoredFile => ({
  bytes: Buffer.from(name, "utf8"),
  mime: "application/pdf",
  filename: `${name}.pdf`,
});

test("returns a saved file and nothing for an unknown id", () => {
  const store = new PackageStore();
  const { packageId } = store.save(new Map([["f1", file("plan")]]));

  assert.equal(store.get(packageId, "f1")?.filename, "plan.pdf");
  assert.equal(store.get(packageId, "missing"), null);
  assert.equal(store.get("missing", "f1"), null);
});

test("stops serving a package once it has expired", () => {
  const store = new PackageStore(1000);
  const now = Date.now();
  const { packageId, expiresAt } = store.save(new Map([["f1", file("plan")]]), now);

  assert.equal(expiresAt, now + 1000);
  assert.equal(store.get(packageId, "f1", now + 999)?.filename, "plan.pdf");
  assert.equal(store.get(packageId, "f1", now + 1001), null);
});

test("evicts the oldest package first when the cap is reached", () => {
  // The buffers are held in memory on a small instance, so the cap is a real
  // ceiling rather than a formality: the newest purchase must always survive.
  const store = new PackageStore(60_000, 2);
  const first = store.save(new Map([["f1", file("first")]]));
  const second = store.save(new Map([["f1", file("second")]]));
  const third = store.save(new Map([["f1", file("third")]]));

  assert.equal(store.size, 2);
  assert.equal(store.get(first.packageId, "f1"), null);
  assert.equal(store.get(second.packageId, "f1")?.filename, "second.pdf");
  assert.equal(store.get(third.packageId, "f1")?.filename, "third.pdf");
});
