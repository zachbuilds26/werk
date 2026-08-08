// Shared abuse protection for every surface that spends money or CPU on a
// caller's behalf. Each model call costs provider quota, and each render costs
// CPU on a single-core instance, so an unmetered public route lets one script
// exhaust the day's quota and take the live service down.
//
// A fixed window per caller plus a concurrency cap is enough here: the limits
// exist to stop runaway use, not to price the service.

import type { RequestHandler, Request, Response } from "express";

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX = 40;
const DEFAULT_MAX_CONCURRENT = 4;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_CALLERS = 10_000;

// The A2A routes sit at the server root and share no mount prefix
// (/message:send, /<tenant>/message:send, /tasks/<id>/artifacts/<id>), so agent
// middleware has to be selected by path shape. Without this the agent limiter
// and its wildcard CORS header would apply to /api and the static site as well.
const A2A_PATH = /^\/(?:[^/]+\/)?(?:message:(?:send|stream)|tasks(?:\/|$))/;

export function isA2APath(path: string): boolean {
  return A2A_PATH.test(path);
}

export type RateLimitOptions = {
  windowMs?: number;
  max?: number;
  maxConcurrent?: number;  /** Sent as the error body. Kept generic so it suits JSON and SSE routes. */
  message?: string;
};

type Entry = { count: number; resetAt: number };

export function callerKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A fixed-window limiter with a concurrency cap. The window is only charged
 * once a request is admitted, so a caller turned away by the concurrency cap
 * does not lose quota for a request that never ran.
 */
export function createRateLimiter(options: RateLimitOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const max = options.max ?? DEFAULT_MAX;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const message = options.message ?? "Too many requests. Try again later.";
  const entries = new Map<string, Entry>();
  let active = 0;

  const sweep = (now: number): void => {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
    // A flood of unique source addresses must not grow the map without bound.
    if (entries.size > MAX_TRACKED_CALLERS) entries.clear();
  };

  const sweeper = setInterval(() => sweep(Date.now()), SWEEP_INTERVAL_MS);
  sweeper.unref();

  const reject = (res: Response, status: number, retryAfter: number, code: string): void => {
    res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
    res.status(status).json({ error: { code, message } });
  };

  return (req, res, next) => {
    const now = Date.now();
    const key = callerKey(req);
    const entry = entries.get(key);
    const current = entry && entry.resetAt > now ? entry : null;

    if (current && current.count >= max) {
      return reject(res, 429, Math.ceil((current.resetAt - now) / 1000), "RATE_LIMITED");
    }
    if (active >= maxConcurrent) {
      return reject(res, 503, 30, "BUSY");
    }

    entries.set(key, {
      count: (current?.count ?? 0) + 1,
      resetAt: current?.resetAt ?? now + windowMs,
    });

    active += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
    };
    // "close" fires for a completed response and for a client that hung up
    // mid-stream, which covers the long-lived SSE routes too.
    res.once("close", release);
    res.once("finish", release);

    next();
  };
}
