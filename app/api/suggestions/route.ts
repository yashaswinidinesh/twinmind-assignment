import { NextRequest, NextResponse } from "next/server";
import { suggestionJsonSchema } from "@/lib/schema";
import { MODEL_CHAT } from "@/lib/defaults";
import type {
  AppSettings,
  MeetingMemory,
  SuggestionBatch,
  TranscriptChunk,
} from "@/lib/types";
import { fetchWithTimeout, formatTime } from "@/lib/utils";

// POST /api/suggestions
//
// The core of the assignment. Takes the recent transcript + current meeting
// memory + the last couple of suggestion batches, and asks GPT-OSS 120B to:
//   1. update the meeting memory
//   2. return exactly 3 fresh suggestions
//
// Design notes to defend in the interview:
// - We deliberately send a small, focused payload: last N chunks + compact
//   memory + recent previews. Groq's latency guide explicitly calls out
//   input token count as the primary driver of TTFT, so this is the right
//   tradeoff for the live path.
// - We use strict JSON-schema structured outputs so the middle column
//   never has to parse messy free-form text. Groq documents strict:true as
//   guaranteeing schema adherence on supported models including gpt-oss-120b.
// - We keep system prompts stable and structured identically across calls
//   so Groq's automatic prompt caching can kick in (exact-prefix matching).
// - We fall back to json_object mode if the structured-outputs call fails
//   (there's an intermittent bug reported in late 2025). Better a slightly
//   messier parse than a broken demo.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 30_000;

type Body = {
  apiKey: string;
  settings: AppSettings;
  transcriptChunks: TranscriptChunk[];
  previousBatches: SuggestionBatch[];
  meetingMemory: MeetingMemory;
};

type GroqChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

type ParsedResult = {
  meetingMemory: MeetingMemory;
  suggestions: unknown[];
};

export async function POST(request: NextRequest) {
  const started = Date.now();

  try {
    const body = (await request.json()) as Body;
    const { apiKey, settings, transcriptChunks, previousBatches, meetingMemory } =
      body;

    if (!apiKey) {
      return new NextResponse("Missing Groq API key.", { status: 400 });
    }
    if (!Array.isArray(transcriptChunks) || transcriptChunks.length === 0) {
      return new NextResponse("Transcript is required.", { status: 400 });
    }

    // --- Build a small, focused payload ---

    const recentChunks = transcriptChunks.slice(-settings.suggestionContextChunks);
    const latestChunk = recentChunks[recentChunks.length - 1];

    const latestTranscript = latestChunk
      ? `[${formatTime(latestChunk.createdAt)}] ${latestChunk.text}`
      : "";

    const recentTranscript = recentChunks
      .map((c) => `[${formatTime(c.createdAt)}] ${c.text}`)
      .join("\n");

    // Previews from the last 2 batches only. More than that crowds context
    // without improving anti-repetition.
    const recentSuggestionsToAvoid = previousBatches
      .slice(0, 2)
      .flatMap((b) => b.items)
      .map((s) => `- ${s.type}: ${s.preview}`)
      .join("\n");

    const userPayload = {
      latestTranscript,
      recentTranscript,
      meetingMemory,
      recentSuggestionsToAvoid: recentSuggestionsToAvoid || "None yet.",
      outputRules: {
        suggestionCount: 3,
        previewsMustStandAlone: true,
        avoidRepeats: true,
        keepVariedAcrossTypes: true,
        stayGrounded: true,
      },
    };

    // --- Primary path: strict JSON-schema structured outputs ---

    const primary = await callGroq(apiKey, settings, userPayload, "schema");

    if (primary.ok && primary.parsed) {
      return NextResponse.json({
        ...primary.parsed,
        latencyMs: Date.now() - started,
        mode: "schema" as const,
      });
    }

    // --- Fallback: json_object mode with an explicit schema in the prompt ---
    //
    // There's an intermittent issue where gpt-oss-120b ignores strict
    // structured outputs (Groq community forum, Oct/Nov 2025). This path
    // keeps the demo working if the primary call misbehaves.

    const fallback = await callGroq(apiKey, settings, userPayload, "json_object");

    if (fallback.ok && fallback.parsed) {
      return NextResponse.json({
        ...fallback.parsed,
        latencyMs: Date.now() - started,
        mode: "json_object" as const,
      });
    }

    return new NextResponse(
      primary.error || fallback.error || "Suggestions call failed.",
      { status: 502 }
    );
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? "Suggestions timed out."
        : err instanceof Error
        ? err.message
        : "Suggestions error.";
    return new NextResponse(msg, { status: 500 });
  }
}

// ---- helpers ----

async function callGroq(
  apiKey: string,
  settings: AppSettings,
  userPayload: unknown,
  mode: "schema" | "json_object"
): Promise<{ ok: boolean; parsed?: ParsedResult; error?: string }> {
  // For the fallback path we append the schema shape to the system prompt
  // so the model still knows exactly what JSON to produce.
  const systemContent =
    mode === "schema"
      ? settings.suggestionPrompt
      : `${settings.suggestionPrompt}

You MUST return a JSON object with this exact shape:
{
  "meetingMemory": {
    "activeTopic": string,
    "shortSummary": string,
    "openQuestions": string[],
    "decisions": string[],
    "actionItems": string[],
    "claimsToVerify": string[]
  },
  "suggestions": [
    {
      "id": string,
      "type": "question" | "talking_point" | "answer" | "fact_check" | "clarification",
      "preview": string,
      "detailQuery": string,
      "rationale": string,
      "confidence": number
    }
  ]
}
"suggestions" must contain exactly 3 items.`;

  const reqBody: Record<string, unknown> = {
    model: MODEL_CHAT,
    temperature: settings.suggestionTemperature,
    max_completion_tokens: 900,
    // Low reasoning effort keeps the live path fast. GPT-OSS 120B supports
    // low/medium/high; medium is default and too slow for 30s cadence.
    reasoning_effort: "low",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  };

  if (mode === "schema") {
    reqBody.response_format = {
      type: "json_schema",
      json_schema: suggestionJsonSchema,
    };
  } else {
    reqBody.response_format = { type: "json_object" };
  }

  const upstream = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(reqBody),
    },
    TIMEOUT_MS
  );

  const text = await upstream.text();

  if (!upstream.ok) {
    return { ok: false, error: text || `Groq error (${upstream.status}).` };
  }

  let json: GroqChatResponse;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "Bad Groq response envelope." };
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    return { ok: false, error: "Empty suggestion payload." };
  }

  let parsed: ParsedResult;
  try {
    parsed = JSON.parse(content) as ParsedResult;
  } catch {
    return { ok: false, error: "Model returned non-JSON content." };
  }

  if (
    !parsed.meetingMemory ||
    !Array.isArray(parsed.suggestions) ||
    parsed.suggestions.length !== 3
  ) {
    return { ok: false, error: "Model returned malformed suggestions." };
  }

  return { ok: true, parsed };
}
