// Call Groq (free tier) through its OpenAI-compatible chat completions endpoint
// with JSON mode. Rotates through GROQ_API_KEY / GROQ_API_KEY_2 / ... when a key
// is rate-limited or exhausted. No SDK needed.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

/** Collect the configured Groq keys in priority order, de-duplicated. */
function groqKeys(): string[] {
  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    ...(process.env.GROQ_API_KEYS ?? "").split(","),
  ]
    .map((k) => k?.trim())
    .filter((k): k is string => Boolean(k));
  return [...new Set(keys)];
}

export function hasGroqKey(): boolean {
  return groqKeys().length > 0;
}

/** Pull a JSON object out of model text. Tolerates code fences and stray prose. */
function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("no JSON object found");
  }
}

type GroqFailure = {
  action: "fail" | "retry" | "next-key";
  error: string;
  status?: number;
};

type GroqResult = { text: string } | GroqFailure;

/** Fire one Groq request with one key. Returns text, or an action for the caller. */
async function groqCall(
  apiKey: string,
  system: string,
  user: string,
  maxTokens: number
): Promise<GroqResult> {
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.4,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      const choice = data.choices?.[0];
      const text = choice?.message?.content;
      if (text) return { text };
      return { action: "fail", error: "Groq returned no content" };
    }

    const body = await res.text().catch(() => "");
    const error = `Groq request failed (HTTP ${res.status})`;
    // A daily quota will not recover during this request. Move to the next key
    // immediately. Invalid credentials are also permanent for this key. A
    // per-minute quota and temporary provider failures get bounded retries first.
    const isDailyLimit = res.status === 429 && /tokens per day|\bTPD\b/i.test(body);
    const action =
      isDailyLimit || res.status === 401 || res.status === 403
        ? "next-key"
        : res.status === 429 || res.status >= 500
          ? "retry"
          : "fail";
    return { action, error, status: res.status };
  } catch (e) {
    // Network-level failure (DNS, connection reset, mid-stream timeout). Treat
    // as transient so the retry loop in groqJson can try again.
    return {
      action: "retry",
      error: `Network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Call Groq and return the parsed JSON object. Each key gets one retry after a
 * short backoff before we roll over to the next; if every key is exhausted we
 * throw.
 */
export async function groqJson<T = unknown>(
  system: string,
  user: string,
  maxTokens = 1500
): Promise<T> {
  const keys = groqKeys();
  if (keys.length === 0) throw new Error("No Groq API key is set (GROQ_API_KEY)");

  // The Groq free tier enforces a tight per-minute token limit (TPM). Retry a
  // per-minute 429 and temporary provider failures with the same key. Rotate at
  // once for daily quotas and unusable credentials, then try the next key.
  const ATTEMPTS_PER_KEY = 3;
  for (const apiKey of keys) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_KEY; attempt++) {
      const result = await groqCall(apiKey, system, user, maxTokens);
      if ("text" in result) return extractJson(result.text) as T;

      if (result.action === "fail") {
        throw new Error("Groq is temporarily unavailable. Try again shortly.");
      }
      if (result.action === "next-key") break;

      const backoff = result.status === 429 ? 12000 : 1200;
      if (attempt < ATTEMPTS_PER_KEY - 1) {
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  throw new Error("Groq is temporarily unavailable. Try again shortly.");
}
