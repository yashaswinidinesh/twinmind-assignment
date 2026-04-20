// Types used across client and server. The suggestion shape here must stay
// in sync with lib/schema.ts so structured outputs return matching data.

export type SuggestionType =
  | "question"
  | "talking_point"
  | "answer"
  | "fact_check"
  | "clarification";

export type TranscriptChunk = {
  id: string;
  createdAt: number; // epoch ms
  text: string;
  durationMs: number;
};

export type MeetingMemory = {
  activeTopic: string;
  shortSummary: string;
  openQuestions: string[];
  decisions: string[];
  actionItems: string[];
  claimsToVerify: string[];
};

export type LiveSuggestion = {
  id: string;
  type: SuggestionType;
  preview: string;      // shown on the card — must be valuable on its own
  detailQuery: string;  // hidden expansion intent used when user clicks
  rationale: string;    // one-line why-this-why-now, for defensibility
  confidence: number;   // 0..1
};

export type SuggestionBatch = {
  id: string;
  createdAt: number;
  items: LiveSuggestion[];
  meetingMemory: MeetingMemory;
  latencyMs: number;
  source: "auto" | "manual";
};

export type ChatMessage = {
  id: string;
  createdAt: number;
  role: "user" | "assistant";
  text: string;
  triggeredBySuggestionId?: string;
  firstTokenMs?: number;
};

export type AppSettings = {
  groqApiKey: string;
  language: string;              // ISO-639-1
  autoRefreshSeconds: number;
  suggestionContextChunks: number;
  chatContextChunks: number;      // context window for expansion + chat
  suggestionTemperature: number;
  chatTemperature: number;
  suggestionPrompt: string;
  expansionPrompt: string;
  chatPrompt: string;
};

export type Telemetry = {
  transcribeMs: number[];
  suggestionsMs: number[];
  chatFirstTokenMs: number[];
};

export type SessionExport = {
  exportedAt: string;
  settings: Omit<AppSettings, "groqApiKey">; // never export the key
  transcript: TranscriptChunk[];
  suggestionBatches: SuggestionBatch[];
  chatHistory: ChatMessage[];
  meetingMemorySnapshots: Array<{ at: number; memory: MeetingMemory }>;
  telemetry: Telemetry;
};
