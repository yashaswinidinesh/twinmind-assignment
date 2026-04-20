import { NextRequest } from "next/server";
import { MODEL_CHAT } from "@/lib/defaults";
import type {
  AppSettings,
  ChatMessage,
  MeetingMemory,
  TranscriptChunk,
} from "@/lib/types";
import { fetchWithTimeout, formatTime } from "@/lib/utils";

// POST /api/chat
//
// Streams a chat completion from GPT-OSS 120B and pipes it straight to the
// client via a ReadableStream. We parse Groq's SSE frames on the server and
// re-emit only the plain text deltas, which keeps the client simple.
//
// Two entry modes:
//   - expansion: the user clicked a suggestion. We use the expansionPrompt,
//     pass the suggestion preview and the hidden detailQuery, and ground
//     the answer in recent transcript + meeting memory.
//   - chat: the user typed a question. We use the chatPrompt and include
//     recent chat history for continuity.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 60_000;

type Body = {
  apiKey: string;
  settings: AppSettings;
  mode: "expansion" | "chat";
  userText: string;
  // For expansion mode:
  suggestionPreview?: string;
  suggestionDetailQuery?: string;
  suggestionType?: string;
  // Shared context:
  transcriptChunks: TranscriptChunk[];
  meetingMemory: MeetingMemory;
  chatHistory: ChatMessage[];
};

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response("Bad request body.", { status: 400 });
  }

  const {
    apiKey,
    settings,
    mode,
    userText,
    suggestionPreview,
    suggestionDetailQuery,
    suggestionType,
    transcriptChunks,
    meetingMemory,
    chatHistory,
  } = body;

  if (!apiKey) return new Response("Missing Groq API key.", { status: 400 });
  if (!userText && mode === "chat") {
    return new Response("Missing user text.", { status: 400 });
  }

  // Context policy, per the assignment brief:
  //
  //   "Clicking a suggestion adds it to the chat and returns a detailed
  //    answer (separate, longer-form prompt with FULL transcript context)."
  //
  // Expansion mode therefore uses the entire transcript — the user clicked
  // a specific card and deserves the most grounded answer we can produce.
  // Free-form chat uses the editable chatContextChunks window because an
  // open-ended question at minute 40 doesn't need the full replay of the
  // meeting to answer well, and keeping it bounded protects TTFT and cost.
  const chatWindow = Math.max(1, Math.min(50, settings.chatContextChunks || 12));
  const recent =
    mode === "expansion" ? transcriptChunks : transcriptChunks.slice(-chatWindow);
  const transcriptBlock = recent
    .map((c) => `[${formatTime(c.createdAt)}] ${c.text}`)
    .join("\n");

  const memoryBlock = JSON.stringify(meetingMemory, null, 2);

  const systemContent =
    mode === "expansion" ? settings.expansionPrompt : settings.chatPrompt;

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemContent },
  ];

  // Fold transcript + memory into a grounding message.
  messages.push({
    role: "system",
    content: `Meeting memory:
${memoryBlock}

Recent transcript (most recent last):
${transcriptBlock || "(no transcript yet)"}`,
  });

  if (mode === "expansion") {
    // Include prior chat turns so the right panel feels continuous when
    // the user mixes clicks and typed questions.
    for (const msg of chatHistory.slice(-6)) {
      messages.push({ role: msg.role, content: msg.text });
    }
    messages.push({
      role: "user",
      content: `The user clicked a suggestion of type "${suggestionType ?? "unknown"}".
Preview on the card: ${suggestionPreview ?? ""}
Internal expansion intent: ${suggestionDetailQuery ?? ""}

Expand this suggestion into a detailed answer following your system instructions.`,
    });
  } else {
    for (const msg of chatHistory.slice(-8)) {
      messages.push({ role: msg.role, content: msg.text });
    }
    messages.push({ role: "user", content: userText });
  }

  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL_CHAT,
          temperature: settings.chatTemperature,
          max_completion_tokens: 700,
          // Medium reasoning for the detailed-answer path; first tokens are
          // still fast and quality is noticeably better than low.
          reasoning_effort: "medium",
          stream: true,
          messages,
        }),
      },
      TIMEOUT_MS
    );
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? "Chat timed out."
        : err instanceof Error
        ? err.message
        : "Chat error.";
    return new Response(msg, { status: 500 });
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    return new Response(errText || "Chat upstream failed.", {
      status: upstream.status || 502,
    });
  }

  // Re-stream content deltas as plain text. This keeps the client tiny
  // (it doesn't need an SSE parser) while still being fully streaming.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Groq returns SSE: lines starting with "data: ".
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") {
              controller.close();
              return;
            }
            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                controller.enqueue(encoder.encode(delta));
              }
            } catch {
              // skip malformed frames
            }
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
