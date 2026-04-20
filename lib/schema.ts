// JSON Schema for the suggestions endpoint.
//
// Groq's structured outputs with strict:true guarantees the model returns
// data matching this shape (per https://console.groq.com/docs/structured-outputs).
// We mirror lib/types.ts exactly so parsing is trivial.
//
// Note: Groq's strict mode requires all properties to be listed in `required`
// and `additionalProperties: false` on every object. Do not relax these.

export const suggestionJsonSchema = {
  name: "live_suggestions",
  strict: true,
  schema: {
    type: "object",
    properties: {
      meetingMemory: {
        type: "object",
        properties: {
          activeTopic: { type: "string" },
          shortSummary: { type: "string" },
          openQuestions: { type: "array", items: { type: "string" } },
          decisions: { type: "array", items: { type: "string" } },
          actionItems: { type: "array", items: { type: "string" } },
          claimsToVerify: { type: "array", items: { type: "string" } },
        },
        required: [
          "activeTopic",
          "shortSummary",
          "openQuestions",
          "decisions",
          "actionItems",
          "claimsToVerify",
        ],
        additionalProperties: false,
      },
      suggestions: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: [
                "question",
                "talking_point",
                "answer",
                "fact_check",
                "clarification",
              ],
            },
            preview: { type: "string" },
            detailQuery: { type: "string" },
            rationale: { type: "string" },
            confidence: { type: "number" },
          },
          required: [
            "id",
            "type",
            "preview",
            "detailQuery",
            "rationale",
            "confidence",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["meetingMemory", "suggestions"],
    additionalProperties: false,
  },
} as const;
