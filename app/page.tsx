"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SettingsDrawer from "@/components/SettingsDrawer";
import {
  DEFAULT_SETTINGS,
  EMPTY_MEETING_MEMORY,
} from "@/lib/defaults";
import type {
  AppSettings,
  ChatMessage,
  LiveSuggestion,
  MeetingMemory,
  SessionExport,
  SuggestionBatch,
  Telemetry,
  TranscriptChunk,
} from "@/lib/types";
import { formatTime, newId, isLikelyHallucination, friendlyErrorMessage } from "@/lib/utils";

// The main page. Holds all session state in memory (no persistence — matches
// the brief: "no login, no data persistence needed when reloading"). Settings
// and API key are kept in sessionStorage so a reviewer doesn't lose them on
// an accidental refresh during a live demo.

const SETTINGS_KEY = "twinmind-settings-v1";

export default function Page() {
  // --- Settings ---
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Load any saved settings from sessionStorage on first mount.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
      } else {
        // Open settings on first load so reviewer paste the API key immediately.
        setSettingsOpen(true);
      }
    } catch {
      // ignore
    }
  }, []);

  function saveSettings(next: AppSettings) {
    setSettings(next);
    try {
      sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  // --- Session state ---
  const [transcript, setTranscript] = useState<TranscriptChunk[]>([]);
  const [batches, setBatches] = useState<SuggestionBatch[]>([]);
  const [memory, setMemory] = useState<MeetingMemory>(EMPTY_MEETING_MEMORY);
  const [memorySnapshots, setMemorySnapshots] = useState<
    Array<{ at: number; memory: MeetingMemory }>
  >([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [telemetry, setTelemetry] = useState<Telemetry>({
    transcribeMs: [],
    suggestionsMs: [],
    chatFirstTokenMs: [],
  });

  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [countdown, setCountdown] = useState(settings.autoRefreshSeconds);

  // --- Refs that mirror state for use inside stable callbacks ---
  // React closures capture values at render time, but the MediaRecorder
  // callback and countdown timer both run across many renders. We mirror
  // the pieces they need into refs so they always see the latest values.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptRef = useRef<TranscriptChunk[]>([]);
  const batchesRef = useRef<SuggestionBatch[]>([]);
  const memoryRef = useRef<MeetingMemory>(EMPTY_MEETING_MEMORY);
  const settingsRef = useRef<AppSettings>(settings);
  const suggestionsInflightRef = useRef(false);
  // Tracks a pending manual refresh so the next flushed MediaRecorder chunk
  // is tagged source: "manual" instead of "auto". Cleared after use.
  const pendingManualRefreshRef = useRef(false);
  // Bumped whenever the countdown should restart from settings.autoRefreshSeconds.
  const [countdownResetKey, setCountdownResetKey] = useState(0);
  // AbortController for the currently streaming chat request, if any.
  // A second click aborts the first so we don't get overlapping assistant bubbles.
  const chatAbortRef = useRef<AbortController | null>(null);
  // Timer that triggers the next recorder stop so a complete chunk is emitted
  // and the cycle repeats. Cleared when recording stops.
  const chunkTimerRef = useRef<number | null>(null);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  useEffect(() => {
    batchesRef.current = batches;
  }, [batches]);
  useEffect(() => {
    memoryRef.current = memory;
  }, [memory]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Auto-scroll transcript and chat.
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  // --- Countdown tick ---
  useEffect(() => {
    if (!recording) return;
    setCountdown(settings.autoRefreshSeconds);
    const id = setInterval(() => {
      setCountdown((c) => (c <= 1 ? settings.autoRefreshSeconds : c - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [recording, settings.autoRefreshSeconds, countdownResetKey]);

  // --- Transcription ---
  const transcribeChunk = useCallback(async (blob: Blob): Promise<TranscriptChunk | null> => {
    const apiKey = settingsRef.current.groqApiKey;
    if (!apiKey) {
      setError("Paste your Groq API key in Settings to start.");
      return null;
    }
    const started = Date.now();
    try {
      // Derive the file extension from the blob's actual mime type.
      // Safari may produce audio/mp4 even when we requested webm.
      const mimeType = blob.type || "audio/webm";
      const ext = mimeType.includes("mp4") ? "mp4" : "webm";
      
      const form = new FormData();
      form.append("file", blob, `chunk-${started}.${ext}`);
      form.append("apiKey", apiKey);
      form.append("language", settingsRef.current.language || "en");

      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      if (!res.ok) {
        const text = await res.text();
        // If it's a format error, show a gentle warning instead of raw JSON
        if (text.includes("could not process file") || text.includes("invalid_request_error")) {
          setError("Audio chunk skipped (format issue). Recording continues.");
        } else {
          setError(`Transcription: ${friendlyErrorMessage(text, res.statusText)}`);
        }
        return null;
      }
      const data = (await res.json()) as {
        text: string;
        durationMs: number;
        latencyMs: number;
      };
      setTelemetry((t) => ({
        ...t,
        transcribeMs: [...t.transcribeMs, Date.now() - started],
      }));
      if (!data.text) return null;
      // Filter known Whisper hallucinations. When the audio is mostly silence
      // Whisper invents short filler phrases it was trained on (YouTube-style
      // outros). If the entire chunk is just these phrases, drop it.
      if (isLikelyHallucination(data.text)) return null;
      const chunk: TranscriptChunk = {
        id: newId(),
        createdAt: Date.now(),
        text: data.text,
        durationMs: data.durationMs,
      };
      setTranscript((prev) => [...prev, chunk]);
      setError(null);
      return chunk;
    } catch (err) {
      setError(
        err instanceof Error ? `Transcription: ${err.message}` : "Transcription error."
      );
      return null;
    }
  }, []);

  // --- Suggestions ---
  const fetchSuggestions = useCallback(
    async (source: "auto" | "manual") => {
      // Prevent overlapping calls. If one is already in flight, skip.
      if (suggestionsInflightRef.current) return;
      const apiKey = settingsRef.current.groqApiKey;
      if (!apiKey) {
        setError("Paste your Groq API key in Settings to start.");
        return;
      }
      if (transcriptRef.current.length === 0) return;

      suggestionsInflightRef.current = true;
      setSuggestionsLoading(true);
      const started = Date.now();
      try {
        const res = await fetch("/api/suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey,
            settings: settingsRef.current,
            transcriptChunks: transcriptRef.current,
            previousBatches: batchesRef.current,
            meetingMemory: memoryRef.current,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          setError(`Suggestions: ${friendlyErrorMessage(text, res.statusText)}`);
          return;
        }
        const data = (await res.json()) as {
          meetingMemory: MeetingMemory;
          suggestions: LiveSuggestion[];
          latencyMs: number;
          mode: "schema" | "json_object";
        };

        const batch: SuggestionBatch = {
          id: newId(),
          createdAt: Date.now(),
          items: data.suggestions,
          meetingMemory: data.meetingMemory,
          latencyMs: data.latencyMs,
          source,
        };
        // Newest batch at the top so older batches push down, matching the
        // prototype. State ordering: index 0 = freshest.
        setBatches((prev) => [batch, ...prev]);
        setMemory(data.meetingMemory);
        setMemorySnapshots((prev) => [
          ...prev,
          { at: Date.now(), memory: data.meetingMemory },
        ]);
        setTelemetry((t) => ({
          ...t,
          suggestionsMs: [...t.suggestionsMs, Date.now() - started],
        }));
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? `Suggestions: ${err.message}` : "Suggestions error."
        );
      } finally {
        suggestionsInflightRef.current = false;
        setSuggestionsLoading(false);
      }
    },
    []
  );

  // --- Recording lifecycle ---
  const stopRecording = useCallback(() => {
    // Clear the scheduled stop so it doesn't fire after we've already stopped.
    if (chunkTimerRef.current !== null) {
      window.clearTimeout(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
    // Stop all tracks and null streamRef FIRST so the recorder's onstop
    // handler sees streamRef as null and doesn't start a new recorder.
    const stream = streamRef.current;
    streamRef.current = null;
    try {
      recorderRef.current?.stop();
    } catch {
      // ignore
    }
    stream?.getTracks().forEach((t) => t.stop());
    recorderRef.current = null;
    setRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    if (!settingsRef.current.groqApiKey) {
      setError("Paste your Groq API key in Settings to start.");
      setSettingsOpen(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Pick the first supported mime type. Safari often doesn't support webm,
      // so we try mp4 as a fallback. Groq's Whisper handles both.
      const preferred = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ];
      const mimeType =
        preferred.find((t) => MediaRecorder.isTypeSupported(t)) || "";

      const timesliceMs = settingsRef.current.autoRefreshSeconds * 1000;

      // We create a FRESH MediaRecorder for every chunk interval. This is the
      // critical fix: using recorder.start(timeslice) produces only ONE valid
      // container chunk — subsequent timeslice chunks are incremental data
      // fragments without the container header, and Whisper can't decode them
      // as standalone files. By stopping and restarting the recorder each
      // interval, every chunk is a complete, self-contained audio file that
      // Whisper can always process.
      const startNewRecorder = () => {
        if (!streamRef.current) return;
        const recorder = new MediaRecorder(
          streamRef.current,
          mimeType ? { mimeType } : undefined
        );
        recorderRef.current = recorder;

        recorder.ondataavailable = async (ev) => {
          if (!ev.data || ev.data.size === 0) return;
          // Consume the pending manual flag if set, so this batch is tagged
          // "manual" instead of "auto".
          const source: "auto" | "manual" = pendingManualRefreshRef.current
            ? "manual"
            : "auto";
          pendingManualRefreshRef.current = false;
          await transcribeChunk(ev.data);
          // Always try to refresh suggestions if we have any transcript,
          // even if this specific chunk failed or was empty.
          if (transcriptRef.current.length > 0) {
            void fetchSuggestions(source);
          }
        };

        recorder.onstop = () => {
          // When a recorder stops, if we're still recording, immediately
          // spin up the next one. This creates a continuous chain of
          // standalone-decodable chunks with minimal audio loss between them.
          if (streamRef.current) {
            startNewRecorder();
          }
        };

        recorder.onerror = (e) => {
          setError(`Recorder error: ${(e as ErrorEvent).message ?? "unknown"}`);
        };

        recorder.start();
        // Schedule a stop so ondataavailable fires with a complete chunk,
        // onstop fires, and a fresh recorder starts.
        chunkTimerRef.current = window.setTimeout(() => {
          try {
            if (recorder.state === "recording") recorder.stop();
          } catch {
            // ignore
          }
        }, timesliceMs);
      };

      startNewRecorder();
      setRecording(true);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? `Mic: ${err.message}` : "Could not start mic."
      );
    }
  }, [transcribeChunk, fetchSuggestions]);

  // Manual reload. If we're recording, flush the buffering MediaRecorder
  // chunk first so the transcript includes the latest audio before we call
  // suggestions — this is the behavior hinted at in the prototype. If we're
  // not recording, fall back to refreshing suggestions against the existing
  // transcript (useful after stopping the mic).
  const onReload = useCallback(() => {
    // Reset the auto-refresh countdown so the next auto-tick starts cleanly.
    setCountdownResetKey((k) => k + 1);

    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      // Mark the next flushed batch as manual. The ondataavailable handler
      // reads and clears this flag.
      pendingManualRefreshRef.current = true;
      // Clear the scheduled stop and stop the recorder now. Stopping will:
      //   1) fire ondataavailable with the complete standalone chunk
      //   2) fire onstop, which spins up a fresh recorder to keep recording
      if (chunkTimerRef.current !== null) {
        window.clearTimeout(chunkTimerRef.current);
        chunkTimerRef.current = null;
      }
      try {
        rec.stop();
        return;
      } catch {
        pendingManualRefreshRef.current = false;
        // fall through
      }
    }
    // Not recording (or stop failed). Only refresh if we have
    // transcript to reason about; otherwise there's nothing to suggest on.
    if (transcriptRef.current.length > 0) {
      void fetchSuggestions("manual");
    }
  }, [fetchSuggestions]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // --- Chat ---

  async function streamChat(params: {
    mode: "expansion" | "chat";
    userText: string;
    triggeredBySuggestion?: LiveSuggestion;
  }) {
    const apiKey = settingsRef.current.groqApiKey;
    if (!apiKey) {
      setError("Paste your Groq API key in Settings to start.");
      return;
    }

    // If a previous stream is still running, cancel it. This prevents
    // two assistant bubbles filling in at once if the user clicks a second
    // suggestion before the first finishes.
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
      chatAbortRef.current = null;
    }
    const abort = new AbortController();
    chatAbortRef.current = abort;

    // Add the user turn synchronously so the UI feels immediate.
    const userMsg: ChatMessage = {
      id: newId(),
      createdAt: Date.now(),
      role: "user",
      text:
        params.mode === "expansion" && params.triggeredBySuggestion
          ? params.triggeredBySuggestion.preview
          : params.userText,
      triggeredBySuggestionId: params.triggeredBySuggestion?.id,
    };
    setChat((prev) => [...prev, userMsg]);

    // Placeholder assistant message we'll mutate as tokens stream in.
    const assistantId = newId();
    const assistantStart = Date.now();
    setChat((prev) => [
      ...prev,
      {
        id: assistantId,
        createdAt: Date.now(),
        role: "assistant",
        text: "",
      },
    ]);
    setChatLoading(true);

    // Small helper so every error path leaves the assistant bubble in a
    // readable state instead of blank.
    const markAssistantFailed = (msg: string) => {
      setChat((prev) =>
        prev.map((m) =>
          m.id === assistantId && !m.text
            ? { ...m, text: `(${msg})` }
            : m
        )
      );
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          settings: settingsRef.current,
          mode: params.mode,
          userText: params.userText,
          suggestionPreview: params.triggeredBySuggestion?.preview,
          suggestionDetailQuery: params.triggeredBySuggestion?.detailQuery,
          suggestionType: params.triggeredBySuggestion?.type,
          transcriptChunks: transcriptRef.current,
          meetingMemory: memoryRef.current,
          chatHistory: chat,
        }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const friendly = friendlyErrorMessage(text, res.statusText);
        setError(`Chat: ${friendly}`);
        markAssistantFailed(friendly);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      let firstTokenAt: number | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        if (!piece) continue;
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          setTelemetry((t) => ({
            ...t,
            chatFirstTokenMs: [...t.chatFirstTokenMs, firstTokenAt! - assistantStart],
          }));
        }
        acc += piece;
        // Functional update so we always mutate the latest snapshot.
        setChat((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, text: acc, firstTokenMs: firstTokenAt ?? undefined } : m))
        );
      }
      if (!acc) {
        // Server closed the stream without emitting any content.
        markAssistantFailed("no content returned");
      }
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Cancelled by a newer request. Leave the partial text as-is so
        // the user can still see whatever streamed before the cancel.
        setChat((prev) =>
          prev.map((m) =>
            m.id === assistantId && !m.text
              ? { ...m, text: "(cancelled)" }
              : m
          )
        );
      } else {
        const msg = err instanceof Error ? err.message : "chat error";
        setError(`Chat: ${msg}`);
        markAssistantFailed(msg);
      }
    } finally {
      // Only clear the ref if it still points to this controller — a newer
      // request may have replaced it already.
      if (chatAbortRef.current === abort) {
        chatAbortRef.current = null;
      }
      setChatLoading(false);
    }
  }

  function onSuggestionClick(s: LiveSuggestion) {
    void streamChat({ mode: "expansion", userText: s.preview, triggeredBySuggestion: s });
  }

  const [chatInput, setChatInput] = useState("");
  function onChatSend() {
    const text = chatInput.trim();
    if (!text) return;
    setChatInput("");
    void streamChat({ mode: "chat", userText: text });
  }

  // --- Export ---
  function onExport() {
    const exportBody: SessionExport = {
      exportedAt: new Date().toISOString(),
      settings: {
        language: settings.language,
        autoRefreshSeconds: settings.autoRefreshSeconds,
        suggestionContextChunks: settings.suggestionContextChunks,
        chatContextChunks: settings.chatContextChunks,
        suggestionTemperature: settings.suggestionTemperature,
        chatTemperature: settings.chatTemperature,
        suggestionPrompt: settings.suggestionPrompt,
        expansionPrompt: settings.expansionPrompt,
        chatPrompt: settings.chatPrompt,
      },
      transcript,
      suggestionBatches: batches,
      chatHistory: chat,
      meetingMemorySnapshots: memorySnapshots,
      telemetry,
    };
    const blob = new Blob([JSON.stringify(exportBody, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `twinmind-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const freshBatchId = batches[0]?.id;

  const avgSuggestions = useMemo(
    () =>
      telemetry.suggestionsMs.length === 0
        ? null
        : Math.round(
            telemetry.suggestionsMs.reduce((a, b) => a + b, 0) /
              telemetry.suggestionsMs.length
          ),
    [telemetry.suggestionsMs]
  );
  const avgFirstToken = useMemo(
    () =>
      telemetry.chatFirstTokenMs.length === 0
        ? null
        : Math.round(
            telemetry.chatFirstTokenMs.reduce((a, b) => a + b, 0) /
              telemetry.chatFirstTokenMs.length
          ),
    [telemetry.chatFirstTokenMs]
  );

  return (
    <>
      <div className="topbar">
        <h1>TwinMind — Live Suggestions</h1>
        <div className="meta">
          {avgSuggestions !== null && (
            <span>suggestions avg {avgSuggestions} ms</span>
          )}
          {avgFirstToken !== null && (
            <span>chat first token avg {avgFirstToken} ms</span>
          )}
          <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button className="export-btn" onClick={onExport}>
            Export session
          </button>
        </div>
      </div>

      <div className="layout">
        {/* LEFT: mic + transcript */}
        <div className="col">
          <header>
            <span>Mic and transcript</span>
            <span>{recording ? "recording" : "idle"}</span>
          </header>
          <div className="mic-wrap">
            <button
              className={`mic-btn${recording ? " recording" : ""}`}
              onClick={recording ? stopRecording : startRecording}
              title={recording ? "Stop recording" : "Start recording"}
              aria-label={recording ? "Stop recording" : "Start recording"}
            >
              ●
            </button>
            <div className="mic-status">
              {recording
                ? `Listening. Transcript appends every ${settings.autoRefreshSeconds}s.`
                : "Click mic to start. Paste your Groq API key in Settings first."}
            </div>
          </div>
          <div className="body">
            {error && <div className="error-banner">{error}</div>}
            {transcript.length === 0 ? (
              <div className="empty">
                No transcript yet. Start the mic to begin.
              </div>
            ) : (
              <>
                {transcript.map((t) => (
                  <div key={t.id} className="transcript-line">
                    <span className="ts">{formatTime(t.createdAt)}</span>
                    {t.text}
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </>
            )}
          </div>
        </div>

        {/* MIDDLE: live suggestions */}
        <div className="col">
          <header>
            <span>Live suggestions</span>
            <span>
              {batches.length} batch{batches.length === 1 ? "" : "es"}
            </span>
          </header>
          <div className="reload-row">
            <button
              className="reload-btn"
              onClick={onReload}
              disabled={
                suggestionsLoading ||
                (!recording && transcript.length === 0)
              }
            >
              {suggestionsLoading ? "Refreshing..." : "Refresh suggestions"}
            </button>
            <span className="countdown">
              {recording
                ? `auto-refresh in ${countdown}s`
                : "auto-refresh paused"}
            </span>
          </div>
          <div className="memory-line" title={memory.shortSummary}>
            <strong>Topic:</strong> {memory.activeTopic}
            {memory.shortSummary && memory.shortSummary !== "No summary yet." ? (
              <>  · {memory.shortSummary}</>
            ) : null}
          </div>
          <div className="body">
            {batches.length === 0 ? (
              <div className="empty">
                Suggestions appear here once the first transcript chunk lands.
              </div>
            ) : (
              batches.map((batch) => (
                <div key={batch.id}>
                  {batch.items.map((s) => (
                    <button
                      key={s.id}
                      className={`suggestion ${
                        batch.id === freshBatchId ? "fresh" : "stale"
                      }`}
                      onClick={() => onSuggestionClick(s)}
                    >
                      <span className={`sug-tag ${s.type}`}>
                        {labelFor(s.type)}
                      </span>
                      <div className="sug-title">{s.preview}</div>
                    </button>
                  ))}
                  <div className="sug-batch-divider">
                    batch · {formatTime(batch.createdAt)} · {batch.latencyMs}ms
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* RIGHT: chat */}
        <div className="col">
          <header>
            <span>Chat (detailed answers)</span>
            <span>session-only</span>
          </header>
          <div className="body">
            {chat.length === 0 ? (
              <div className="empty">
                Click a suggestion above or type a question below. Answers
                stream in with full transcript context.
              </div>
            ) : (
              chat.map((m) => (
                <div
                  key={m.id}
                  className={`chat-msg ${m.role === "user" ? "user" : ""}`}
                >
                  <div className="who">
                    {m.role === "user" ? "You" : "Assistant"}
                    {m.firstTokenMs ? ` · first token ${m.firstTokenMs} ms` : ""}
                  </div>
                  <div className="bubble">{m.text || (chatLoading && m.role === "assistant" ? "..." : "")}</div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="chat-input-row">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onChatSend();
                }
              }}
              placeholder="Ask anything about the meeting..."
              disabled={chatLoading}
            />
            <button onClick={onChatSend} disabled={chatLoading || !chatInput.trim()}>
              Send
            </button>
          </div>
        </div>
      </div>

      <SettingsDrawer
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={saveSettings}
      />
    </>
  );
}

function labelFor(t: LiveSuggestion["type"]): string {
  switch (t) {
    case "question":
      return "Question to ask";
    case "talking_point":
      return "Talking point";
    case "answer":
      return "Answer";
    case "fact_check":
      return "Fact-check";
    case "clarification":
      return "Clarification";
  }
}
