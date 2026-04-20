// Short helpers used across client and server. Kept tiny on purpose —
// pulling in a utility lib would be over-engineering for this scope.

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function newId(): string {
  // Prefer crypto.randomUUID when available; fall back to a short random id.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Fetch with an AbortController-based timeout.
 * We do this because the live demo must not hang on a slow upstream.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Detect common Whisper hallucinations during silence. Whisper is trained
 * heavily on YouTube audio and will generate filler outros when given silent
 * or near-silent audio. If the entire chunk is one of these known phrases,
 * we treat it as silence and drop it rather than polluting the transcript.
 *
 * This is intentionally a small denylist of exact and near-exact matches
 * rather than a fuzzy classifier — we only want to drop obvious junk, not
 * legitimate short utterances.
 */
const HALLUCINATION_PHRASES = new Set(
  [
    "thank you",
    "thanks",
    "thanks for watching",
    "thank you for watching",
    "thank you very much",
    "thanks for watching the video",
    "thank you for watching the video",
    "please subscribe",
    "like and subscribe",
    "bye",
    "bye bye",
    "okay",
    "ok",
    "all right",
    "alright",
    "yeah",
    "you",
    ".",
  ].map((s) => s.toLowerCase())
);

export function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return true;
  // Normalise: split on sentence delimiters, strip trailing punctuation.
  const parts = trimmed
    .split(/[.?!,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return true;
  // If EVERY sentence is a known hallucination phrase, drop the chunk.
  return parts.every((p) => HALLUCINATION_PHRASES.has(p));
}

/**
 * Turn noisy upstream errors (raw Groq JSON, etc.) into short, clean
 * messages suitable for the error banner and failed chat bubbles. We only
 * pattern-match on well-known cases; anything unrecognised passes through
 * trimmed to a reasonable length.
 */
export function friendlyErrorMessage(
  bodyText: string,
  statusText: string
): string {
  const raw = (bodyText || statusText || "").trim();
  if (!raw) return "Request failed.";
  const lower = raw.toLowerCase();
  if (lower.includes("rate_limit_exceeded") || lower.includes("rate limit reached")) {
    return "Groq daily rate limit reached. Wait for the quota to reset or upgrade your Groq tier in console.groq.com/settings/billing.";
  }
  if (lower.includes("invalid_api_key") || lower.includes("incorrect api key")) {
    return "Groq API key is invalid. Paste a fresh key in Settings.";
  }
  if (lower.includes("context_length_exceeded")) {
    return "Meeting is too long for the current context window. Lower the context window in Settings.";
  }
  // Fall back to a trimmed version of whatever we got.
  return raw.length > 240 ? raw.slice(0, 240) + "…" : raw;
}
