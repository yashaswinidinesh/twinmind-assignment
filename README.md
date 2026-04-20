# TwinMind Live Suggestions

My submission for the TwinMind assignment. Built this in a week. Here's what it does and how.

**Live app:** ADD_YOUR_VERCEL_URL_HERE
**Repo:** ADD_YOUR_GITHUB_URL_HERE

## What it does

Three columns. Mic and transcript on the left, live suggestions in the middle (three cards every 30s), chat on the right. Click a card → detailed answer streams in. Type a question → same thing. Export the session as JSON when done.

Uses Whisper Large V3 for transcription and GPT-OSS 120B for suggestions and chat, both via Groq. You paste your own API key in Settings.

## Running it locally

Need Node 20.9+ and a Groq key from console.groq.com.

```
git clone ADD_YOUR_GITHUB_URL_HERE
cd twinmind-app
npm install
npm run dev
```

Open localhost:3000, paste key in Settings, click the mic.

## What I spent my time on

The brief is clear: the whole thing is about showing the right suggestion at the right time. UI exploration is explicitly discouraged. So I didn't touch the layout — it matches the reference mockup. Where I spent time was the suggestion engine.

Three things carry most of the weight:

**Rolling meeting memory.** Instead of sending the entire transcript every 30 seconds (expensive, slow), the model maintains a small structured summary — active topic, two-sentence summary, open questions, decisions, action items, claims to verify — and that summary gets fed back into the next call. So a suggestion at minute 10 knows about a decision made at minute 2, without shipping minute 2's transcript again.

**Anti-repetition.** The last two batches of suggestion previews get passed into the next call with explicit instructions not to restate them unless context materially changed. Without this, live assistants tend to say the same thing in slightly different words every 30 seconds — that's the #1 way they feel broken.

**Two-layer suggestion shape.** Each suggestion card has a short visible preview and a hidden `detailQuery`. The preview is what you see; the detailQuery is what gets sent if you click. This lets the card stay short and scannable while the clicked answer uses a much richer prompt — "expand this question with the full transcript in view" rather than just "elaborate on this sentence."

## Prompt strategy

Two different paths, two different context strategies.

**Live path (every 30s):** Keep it small. Groq's latency docs say input token count is the main driver of time-to-first-token, so I send only:
- last 6 transcript chunks (~3 min)
- current meeting memory
- previews from last 2 batches
- nothing else

**Click path (user committed to reading):** Quality beats latency here. Send the full transcript, the meeting memory, and the hidden detailQuery. The user waits a bit longer but gets a real answer.

**Free-form typed questions:** Bounded window (default 12 chunks, editable in Settings). At minute 40 you don't need every previous second to answer a yes/no question well.

## Tradeoffs I made

No animations, no icon library, no framer-motion, no Tailwind. The brief said not to spend time on UI exploration and I took that literally. One runtime dependency: `next`.

No WebSockets for audio. MediaRecorder client-side, zero server state. Tradeoff: chunks can cut mid-word at the 30-second boundary. Manageable.

No database. Session-only state, as the brief says.

Stop-and-restart the MediaRecorder every 30s instead of using a single long recorder with `timeslice`. Learned this the hard way — with a single recorder, only the first chunk has a valid container header, and every subsequent chunk is a headerless fragment Whisper can't decode. Restarting each interval means every chunk is a complete, independently-decodable audio file.

Client-side filter for Whisper hallucinations. During silence, Whisper tends to invent filler phrases it was trained on ("Thank you", "Thanks for watching", etc. — YouTube outros are everywhere in its training data). If a chunk is entirely these known phrases, I drop it before it hits the transcript. Small denylist, exact matches only, doesn't affect legitimate short utterances.

## Settings

All of these are editable in the drawer:

- Groq API key (sessionStorage, tab only)
- Language hint for Whisper
- Auto-refresh cadence (seconds)
- Live suggestion context window (chunks)
- Chat context window (chunks)
- Temperatures for both paths
- All three prompts (live, click, chat)

"Reset to defaults" is one click. Defaults are what I landed on after trial and error.

## Export

JSON file with: full transcript, every suggestion batch (with the meeting memory snapshot at that moment + server latency + auto/manual tag), full chat history with first-token latencies, all memory snapshots over time, and a telemetry block. API key is excluded.

## Things that could be better

1. **Eval harness.** Feed 10 recorded meetings through the suggestions endpoint, grade against a rubric. My defaults are based on judgment right now, not measurement. That's the biggest gap.
2. **Client-side audio preprocessing.** Downsample to 16kHz mono WAV before sending to Whisper. Groq's docs call that out as the lowest-latency path and I didn't get to it.
3. **Voice-activity detection.** Break chunks on silences instead of hard 30-second boundaries so sentences don't get cut mid-word.

## Stack

Next.js 16, React 19, TypeScript 5.6. Three API routes under `app/api/`. Plain CSS. That's everything.

## File map

```
app/page.tsx             Session state, mic lifecycle, UI
app/api/transcribe/      Whisper Large V3 with retry on format errors
app/api/suggestions/     GPT-OSS 120B with strict JSON schema + fallback
app/api/chat/            Streaming chat, click-expansion and free-form modes
components/              Settings drawer
lib/defaults.ts          Prompts — read these first if you want to understand the approach
lib/types.ts             Shared contracts
lib/schema.ts            Strict output schema
lib/utils.ts             Small helpers including hallucination filter
```

## A note on using TwinMind

Used the live suggestions feature before building this. Two things I'd change: (1) suggestions during quiet stretches still feel generic when saying nothing would be better, and (2) when the conversation pivots topics mid-meeting, prior context lingers longer than it should. The rolling meeting memory in this submission is my attempt at the second one.
