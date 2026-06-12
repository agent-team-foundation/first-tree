import type { OpenQuestionRequest } from "@first-tree/shared";
import { useState } from "react";
import { RequestDock } from "../components/chat/request-dock.js";
import { allRequiredSelected, buildAnswerDraft, recoverAnswerSelections } from "../components/chat/request-state.js";

/**
 * DEV-only visual review for `RequestDock` — the open question pinned above
 * the composer. No backend / no auth — same gating as the other `/preview/*`
 * routes (DEV-only in `app.tsx`).
 *
 * Each mode renders the production dock against a mock composer that mirrors
 * chat-view's wiring contract — including the derived-selection model: the
 * draft is the single source of truth and the selection highlight is derived
 * from it via `recoverAnswerSelections`, so clicking an option REPLACES the
 * draft, editing the text away from a clean answer drops the highlight, and
 * the helper line flips between resolve / judge / empty. The "send" button
 * just echoes which path the real composer would take.
 */

const MODES: Record<string, { label: string; payload: OpenQuestionRequest }> = {
  single: {
    label: "single",
    payload: {
      subject: "Deploy strategy",
      questions: [
        {
          id: "q1",
          prompt: "Blue-green or rolling update?",
          kind: "single",
          options: ["Blue-green", "Rolling update", "Keep as-is"],
          required: true,
        },
      ],
      allowExtra: false,
    },
  },
  free: {
    label: "free-text",
    payload: {
      subject: "Launch concerns",
      questions: [
        { id: "q1", prompt: "Any remaining concerns before launch?", kind: "free", options: [], required: true },
      ],
      allowExtra: false,
    },
  },
  multi: {
    label: "multi-question",
    payload: {
      subject: "Release plan",
      questions: [
        { id: "q1", prompt: "Strategy?", kind: "single", options: ["Blue-green", "Rolling"], required: true },
        { id: "q2", prompt: "Window?", kind: "single", options: ["Friday", "Monday"], required: true },
      ],
      allowExtra: false,
    },
  },
  extra: {
    label: "option + note",
    payload: {
      subject: "Canary ratio",
      questions: [
        { id: "q1", prompt: "First canary batch?", kind: "single", options: ["5%", "20%", "50%"], required: true },
      ],
      allowExtra: true,
    },
  },
};

function ModeBlock({ modeKey, payload }: { modeKey: string; payload: OpenQuestionRequest }) {
  const [draft, setDraft] = useState("");
  const [sentAs, setSentAs] = useState<string | null>(null);

  // Mirrors chat-view's derived-selection model: no stored selection state.
  const selections = recoverAnswerSelections(draft, payload.questions);
  const directResolve =
    draft.trim().length > 0 &&
    draft.trim() === buildAnswerDraft(payload, selections) &&
    allRequiredSelected(payload, selections);

  const pick = (prompt: string, option: string) => {
    setDraft(buildAnswerDraft(payload, { ...selections, [prompt]: option }));
    setSentAs(null);
  };

  const edit = (value: string) => {
    setDraft(value);
    setSentAs(null);
  };

  return (
    <section style={{ marginBottom: "var(--sp-6)" }}>
      <h2 className="mono text-caption font-semibold" style={{ color: "var(--fg-3)", textTransform: "uppercase" }}>
        {MODES[modeKey]?.label}
      </h2>
      <div
        style={{
          marginTop: "var(--sp-2)",
          maxWidth: 720,
          padding: "var(--sp-3)",
          background: "var(--bg)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
        }}
      >
        <RequestDock
          requestId={`req-${modeKey}`}
          payload={payload}
          selections={selections}
          directResolve={directResolve}
          draftEmpty={draft.trim().length === 0}
          askerName="deploy-agent"
          onPick={pick}
        />
        {/* mock composer — mirrors the wiring contract, not the real chrome */}
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-end" }}>
          <textarea
            value={draft}
            onChange={(e) => edit(e.target.value)}
            placeholder="Pick an option above, or type to discuss…"
            className="text-body"
            style={{
              flex: 1,
              border: "var(--hairline) solid var(--border-strong)",
              borderRadius: "var(--radius-input)",
              background: "var(--bg-raised)",
              padding: "var(--sp-1_5) var(--sp-2)",
              color: "var(--fg)",
              minHeight: "var(--sp-10)",
              resize: "vertical",
            }}
          />
          <button
            type="button"
            className="text-body"
            disabled={draft.trim().length === 0}
            onClick={() => {
              setSentAs(
                directResolve
                  ? "→ resolves.answered (direct resolve, red dot cleared)"
                  : "→ plain reply (agent judges; question stays open)",
              );
              setDraft("");
            }}
            style={{
              border: "none",
              borderRadius: "var(--radius-input)",
              background: "var(--primary)",
              color: "var(--primary-on)",
              padding: "var(--sp-1_5) var(--sp-3)",
              cursor: draft.trim().length === 0 ? "not-allowed" : "pointer",
              opacity: draft.trim().length === 0 ? 0.4 : 1,
            }}
          >
            Send
          </button>
        </div>
        {sentAs ? (
          <div className="mono text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1_5)" }}>
            sent {sentAs}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function RequestDockPreviewPage() {
  return (
    <div style={{ padding: "var(--sp-6)", background: "var(--bg-sunken)", minHeight: "100vh" }}>
      <h1 className="text-subtitle font-semibold" style={{ marginBottom: "var(--sp-1)" }}>
        RequestDock preview
      </h1>
      <p className="text-body" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-4)" }}>
        Click an option → it fills the box (replace, not append). The highlight derives from the draft: text that is a
        clean answer (clicked or hand-typed) resolves on send; anything else goes to the agent to judge.
      </p>
      {Object.entries(MODES).map(([key, m]) => (
        <ModeBlock key={key} modeKey={key} payload={m.payload} />
      ))}
    </div>
  );
}
