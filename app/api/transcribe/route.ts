import { NextRequest, NextResponse } from "next/server";
import { MODEL_TRANSCRIBE } from "@/lib/defaults";
import { fetchWithTimeout } from "@/lib/utils";

// POST /api/transcribe
//
// Accepts a multipart/form-data upload with:
//   file: audio blob (webm/mp4/wav/mp3/...)
//   apiKey: user's Groq API key (from Settings; never stored server-side)
//   language: optional ISO-639-1 code — passing this improves accuracy and
//             latency per Groq docs.
//
// Uses whisper-large-v3 with response_format=verbose_json. We send the correct
// filename extension derived from the blob's actual mime type, which is what
// Groq's Whisper uses to pick a decoder. If the first attempt still fails with
// a "could not process file" format error, we retry once with an alternate
// extension before giving up. This keeps audio from being silently dropped
// when the browser labels the mime type imprecisely.
//
// Runs on the Node runtime so FormData file handling is predictable.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 60_000;

// Pick the most likely filename extension for a given mime type. Groq decides
// how to decode based on this, so getting it right matters.
function extFor(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "mp4";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  // default for Chrome/Firefox on Mac/Linux
  return "webm";
}

// A single upstream attempt. Returns the raw Response so the caller can decide
// whether to retry or surface the error.
async function attemptTranscribe(
  file: Blob,
  filename: string,
  apiKey: string,
  language: string
) {
  const upstreamForm = new FormData();
  upstreamForm.append("file", file, filename);
  upstreamForm.append("model", MODEL_TRANSCRIBE);
  upstreamForm.append("response_format", "verbose_json");
  upstreamForm.append("temperature", "0");
  if (language) upstreamForm.append("language", language);

  return fetchWithTimeout(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
    },
    TIMEOUT_MS
  );
}

// Detect the specific Groq "bad media" error so we know it's worth retrying
// with a different filename extension rather than failing loudly.
function isFormatError(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText);
    return (
      parsed?.error?.type === "invalid_request_error" &&
      typeof parsed?.error?.message === "string" &&
      parsed.error.message.includes("could not process file")
    );
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const started = Date.now();

  try {
    const form = await request.formData();
    const file = form.get("file");
    const apiKey = form.get("apiKey");
    const language = (form.get("language") as string | null) || "en";

    if (!apiKey || typeof apiKey !== "string") {
      return new NextResponse("Missing Groq API key.", { status: 400 });
    }
    if (!(file instanceof Blob)) {
      return new NextResponse("Missing audio file.", { status: 400 });
    }
    if (file.size === 0) {
      return new NextResponse("Empty audio file.", { status: 400 });
    }

    // Primary attempt: derive the extension from what the browser told us.
    const primaryExt = extFor(file.type || "audio/webm");
    let upstream = await attemptTranscribe(
      file,
      `chunk.${primaryExt}`,
      apiKey,
      language
    );
    let bodyText = await upstream.text();

    // Retry once with a fallback extension if Groq couldn't decode the file.
    // Browsers (especially Safari) sometimes mislabel mime types, so swapping
    // webm<->mp4 frequently recovers audio that would otherwise be lost.
    if (!upstream.ok && isFormatError(bodyText)) {
      const fallbackExt = primaryExt === "webm" ? "mp4" : "webm";
      upstream = await attemptTranscribe(
        file,
        `chunk.${fallbackExt}`,
        apiKey,
        language
      );
      bodyText = await upstream.text();
    }

    if (!upstream.ok) {
      // Still failing after retry. If it's a format error we can't recover
      // from, return an empty transcript so the app keeps running without
      // showing a red banner. Any other error is surfaced normally.
      if (isFormatError(bodyText)) {
        return NextResponse.json({
          text: "",
          durationMs: 0,
          latencyMs: Date.now() - started,
        });
      }
      return new NextResponse(bodyText || "Transcription failed.", {
        status: upstream.status,
      });
    }

    let parsed: { text?: string; duration?: number } = {};
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return new NextResponse("Bad transcription payload.", { status: 502 });
    }

    return NextResponse.json({
      text: (parsed.text || "").trim(),
      durationMs: Math.round(((parsed.duration as number) || 0) * 1000),
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? "Transcription timed out."
        : err instanceof Error
        ? err.message
        : "Transcription error.";
    return new NextResponse(msg, { status: 500 });
  }
}
