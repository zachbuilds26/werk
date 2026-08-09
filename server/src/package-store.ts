import crypto from "node:crypto";
import express from "express";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
// Each record holds every rendered file for one purchase as in-memory buffers,
// so the store is capped as well as expiry-swept. Sized for a small instance.
const MAX_TRACKED_PACKAGES = 50;
const SWEEP_MS = 5 * 60 * 1000;

export type StoredFile = {
  bytes: Buffer;
  mime: string;
  filename: string;
};

type PackageRecord = {
  files: Map<string, StoredFile>;
  expiresAt: number;
};

/**
 * Holds the rendered files of a paid package so the buyer can fetch them by URL
 * after the response has been sent.
 *
 * This is process memory on an instance with no disk: a restart or a redeploy
 * loses every URL. That is why the paid response also carries the zip inline and
 * states an expiry — the links are the convenience path, not the only copy.
 */
export class PackageStore {
  private packages = new Map<string, PackageRecord>();

  constructor(private ttlMs: number = DEFAULT_TTL_MS, private max: number = MAX_TRACKED_PACKAGES) {
    // Unref'd so a idle sweep timer never holds the process open.
    setInterval(() => this.prune(), SWEEP_MS).unref?.();
  }

  save(files: Map<string, StoredFile>, now = Date.now()): { packageId: string; expiresAt: number } {
    this.prune(now);
    const packageId = crypto.randomUUID();
    const expiresAt = now + this.ttlMs;
    this.packages.set(packageId, { files, expiresAt });
    this.evictOverflow();
    return { packageId, expiresAt };
  }

  get(packageId: string, fileId: string, now = Date.now()): StoredFile | null {
    const record = this.packages.get(packageId);
    if (!record) return null;
    if (record.expiresAt <= now) {
      this.packages.delete(packageId);
      return null;
    }
    return record.files.get(fileId) ?? null;
  }

  get size(): number {
    return this.packages.size;
  }

  private prune(now = Date.now()): void {
    for (const [packageId, record] of this.packages) {
      if (record.expiresAt <= now) this.packages.delete(packageId);
    }
    this.evictOverflow();
  }

  // Map iterates in insertion order, so the first key is always the oldest.
  private evictOverflow(): void {
    while (this.packages.size > this.max) {
      const oldest = this.packages.keys().next();
      if (oldest.done) return;
      this.packages.delete(oldest.value);
    }
  }
}

/**
 * Free download route for files a buyer has already paid for.
 *
 * Mounted ahead of the x402 middleware so a paid-for file can never answer 402,
 * and kept in its own router so it escapes both the marketplace router's forced
 * JSON content type and its terminal catch-all.
 */
export function createPackageFilesRouter(store: PackageStore): express.Router {
  const router = express.Router();

  router.get("/:packageId/:fileId", (req, res) => {
    const file = store.get(req.params.packageId, req.params.fileId);
    if (!file) {
      return res.status(404).json({
        error: { code: "FILE_NOT_FOUND", message: "That file has expired or does not exist. Use the zip included in the purchase response." },
      });
    }
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename.replace(/"/g, "")}"`);
    return res.send(file.bytes);
  });

  // Never fall through: the SPA catch-all would answer a download with index.html.
  router.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No Werk file route for ${req.method} ${req.originalUrl}.` } });
  });

  return router;
}
