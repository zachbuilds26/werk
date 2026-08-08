// Keep the hosted instance reachable. A free Render web service is spun down
// after a stretch with no inbound traffic, and a cold start can take long
// enough that a marketplace reviewer's task times out before the first byte
// arrives — the recorded cause of two rejected listing reviews.
//
// An outbound request to our own public URL counts as inbound traffic, so a
// timer inside the process keeps the instance warm without depending on an
// external scheduler. Render publishes the public URL as RENDER_EXTERNAL_URL;
// PUBLIC_URL overrides it for other hosts. With neither set (local dev) the
// keeper stays off.

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;

export type KeepAliveHandle = { enabled: boolean; url: string | null; stop: () => void };

function readInterval(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MIN_INTERVAL_MS ? parsed : DEFAULT_INTERVAL_MS;
}

export function keepAliveUrl(env = process.env): string | null {
  const base = (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}/api/health`;
}

export function startKeepAlive(env = process.env): KeepAliveHandle {
  const url = keepAliveUrl(env);
  if (!url || env.KEEPALIVE_ENABLED === "false") {
    return { enabled: false, url, stop: () => undefined };
  }

  const ping = async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      await fetch(url, { method: "GET", signal: controller.signal });
    } catch {
      // A missed ping is not actionable: the next tick retries, and a hard
      // failure here must never take the server down.
    } finally {
      clearTimeout(timeout);
    }
  };

  const timer = setInterval(() => void ping(), readInterval(env.KEEPALIVE_INTERVAL_MS));
  timer.unref();
  return { enabled: true, url, stop: () => clearInterval(timer) };
}
