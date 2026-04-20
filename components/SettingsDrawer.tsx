"use client";

import { useState, useEffect } from "react";
import type { AppSettings } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import { clamp } from "@/lib/utils";

// Settings drawer.
//
// Exposes exactly what the assignment calls for: Groq API key, editable
// prompts (live suggestions, expansion on click, chat), and context/latency
// knobs. Reset-to-defaults is provided per-field implicitly via a single
// "Reset all" button because users will tweak prompts in ways that hurt
// quality and need a fast way back.

type Props = {
  open: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (next: AppSettings) => void;
};

export default function SettingsDrawer({ open, settings, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);

  // Keep the draft in sync if the parent settings change (e.g. on first mount
  // after loading from sessionStorage).
  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  if (!open) return null;

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function resetAll() {
    // Preserve the API key on reset — users should not have to retype it.
    const resetDraft = { ...DEFAULT_SETTINGS, groqApiKey: draft.groqApiKey };
    setDraft(resetDraft);
    // Immediately save and close so the reset takes effect right away
    onSave(resetDraft);
    onClose();
  }

  function save() {
    // Clamp numeric fields before saving so bad input can't break API calls.
    const safe: AppSettings = {
      ...draft,
      autoRefreshSeconds: clamp(Math.round(draft.autoRefreshSeconds), 10, 180),
      suggestionContextChunks: clamp(
        Math.round(draft.suggestionContextChunks),
        2,
        20
      ),
      chatContextChunks: clamp(
        Math.round(draft.chatContextChunks),
        1,
        50
      ),
      suggestionTemperature: clamp(draft.suggestionTemperature, 0, 1),
      chatTemperature: clamp(draft.chatTemperature, 0, 1),
      language: draft.language.trim().toLowerCase() || "en",
    };
    onSave(safe);
    onClose();
  }

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="drawer" role="dialog" aria-modal="true">
        <header>
          <h2>Settings</h2>
          <button className="drawer-close" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="body">
          <div className="field">
            <label>Groq API key</label>
            <input
              type="password"
              value={draft.groqApiKey}
              onChange={(e) => update("groqApiKey", e.target.value)}
              placeholder="gsk_..."
              autoComplete="off"
              spellCheck={false}
            />
            <div className="hint">
              Held in sessionStorage for this tab only. Sent to this app&apos;s
              server routes, which forward requests to Groq and do not persist
              or log the key.
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label>Language (ISO-639-1)</label>
              <input
                type="text"
                value={draft.language}
                onChange={(e) => update("language", e.target.value)}
                placeholder="en"
              />
              <div className="hint">
                Passing this hint improves Whisper accuracy and latency.
              </div>
            </div>
            <div className="field">
              <label>Auto-refresh (seconds)</label>
              <input
                type="number"
                min={10}
                max={180}
                value={draft.autoRefreshSeconds}
                onChange={(e) =>
                  update("autoRefreshSeconds", Number(e.target.value))
                }
              />
              <div className="hint">
                Audio chunk + suggestion refresh cadence. Default 30s.
              </div>
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label>Suggestion context (chunks)</label>
              <input
                type="number"
                min={2}
                max={20}
                value={draft.suggestionContextChunks}
                onChange={(e) =>
                  update("suggestionContextChunks", Number(e.target.value))
                }
              />
              <div className="hint">
                How many recent transcript chunks feed the live path. Larger
                means more context but slower TTFT.
              </div>
            </div>
            <div className="field">
              <label>Suggestion temperature</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={draft.suggestionTemperature}
                onChange={(e) =>
                  update("suggestionTemperature", Number(e.target.value))
                }
              />
              <div className="hint">Low values keep suggestions grounded.</div>
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label>Chat/expansion context (chunks)</label>
              <input
                type="number"
                min={1}
                max={50}
                value={draft.chatContextChunks}
                onChange={(e) =>
                  update("chatContextChunks", Number(e.target.value))
                }
              />
              <div className="hint">
                How many recent transcript chunks feed free-form chat
                questions. Clicked suggestions always use the full transcript
                per the assignment brief.
              </div>
            </div>
            <div className="field">
              <label>Chat temperature</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={draft.chatTemperature}
                onChange={(e) =>
                  update("chatTemperature", Number(e.target.value))
                }
              />
            </div>
          </div>

          <div className="field">
            <label>Live suggestion prompt</label>
            <textarea
              value={draft.suggestionPrompt}
              onChange={(e) => update("suggestionPrompt", e.target.value)}
            />
            <div className="hint">
              System prompt for the middle column. Keep the structure stable
              so Groq&apos;s prompt caching can reuse the prefix.
            </div>
          </div>

          <div className="field">
            <label>Expansion prompt (clicked suggestion)</label>
            <textarea
              value={draft.expansionPrompt}
              onChange={(e) => update("expansionPrompt", e.target.value)}
            />
            <div className="hint">
              System prompt used when a user clicks a suggestion card.
            </div>
          </div>

          <div className="field">
            <label>Chat prompt (free-form questions)</label>
            <textarea
              value={draft.chatPrompt}
              onChange={(e) => update("chatPrompt", e.target.value)}
            />
          </div>
        </div>

        <div className="drawer-footer">
          <button className="secondary" onClick={resetAll}>
            Reset to defaults
          </button>
          <button onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
