import type { OpenQuestionRequest } from "@first-tree/shared";
import { useState } from "react";
import { RequestDock } from "../components/chat/request-dock.js";
import { allRequiredAnswered } from "../components/chat/request-state.js";

/**
 * DEV-only visual review for `RequestDock` — the open question pinned above
 * the composer. No backend / no auth — same gating as the other `/preview/*`
 * routes (DEV-only in `app.tsx`).
 *
 * Each mode renders the production dock against a mock composer that mirrors
 * chat-view's wiring contract — including the decoupled-selection model:
 * clicking an option sets a stored selection (it does NOT touch the composer
 * draft), the composer holds free text only, and sending ALWAYS resolves once
 * every required question is answered through either channel. The "send"
 * button just echoes that the real composer would resolve.
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
  context: {
    label: "wired context jump + long subject",
    payload: {
      subject: "Long request subject that checks mobile header wrapping with context jump",
      questions: [
        {
          id: "q1",
          prompt: "Approve this rollout gate after reviewing the full request context?",
          kind: "single",
          options: ["Approve", "Hold"],
          required: true,
        },
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
  legacy: {
    label: "legacy wall-of-text prompt (pre-cap markdown crammed into --question)",
    payload: {
      questions: [
        {
          id: "q1",
          prompt: [
            "## Meeting records landed in the tree",
            "",
            "### 2026-06-02 team regular meeting — your asks",
            "① **Workflow planning** — this week's focus is deep OpenClaw usage, wiring it into the workflow → **landed**: goal/NODE.md updated",
            "② **Consensus capture** — move capture rules out of agent system prompts into a skill (P3)",
            "③ **Git workflow convergence** — agents integrate via skill/prompt upgrades, not direct pushes",
            "",
            "### 2026-06-03 team regular meeting — follow-ups",
            "① Planning conclusions merged into raw-context; branch notes pending",
            "",
            "Answer ① status quo OK / ② which section to change (explain in chat)?",
          ].join("\n"),
          kind: "single",
          options: ["OK as landed", "Needs changes (explain in chat)"],
          required: true,
        },
      ],
      allowExtra: false,
    },
  },
};

function ModeBlock({ modeKey, payload }: { modeKey: string; payload: OpenQuestionRequest }) {
  const [draft, setDraft] = useState("");
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [sentAs, setSentAs] = useState<string | null>(null);

  // Mirrors chat-view's decoupled-selection model: option clicks live in their
  // own state, the composer is free text only, and sending resolves once every
  // required question is answered through either channel.
  const directResolve = allRequiredAnswered(payload, selections, draft);

  const pick = (prompt: string, option: string) => {
    setSelections((prev) => ({ ...prev, [prompt]: option }));
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
          onJumpToOrigin={modeKey === "context" ? () => setSentAs("→ jumped to timeline request context") : undefined}
        />
        {/* mock composer — mirrors the wiring contract, not the real chrome */}
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-end" }}>
          <textarea
            value={draft}
            onChange={(e) => edit(e.target.value)}
            placeholder="Pick an option above, or type a free-text answer…"
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
            disabled={!directResolve}
            onClick={() => {
              setSentAs("→ resolves.answered (red dot cleared)");
              setDraft("");
              setSelections({});
            }}
            style={{
              border: "none",
              borderRadius: "var(--radius-input)",
              background: "var(--primary)",
              color: "var(--primary-on)",
              padding: "var(--sp-1_5) var(--sp-3)",
              cursor: directResolve ? "pointer" : "not-allowed",
              opacity: directResolve ? 1 : 0.4,
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
        Click an option → it highlights but does NOT touch the composer (decoupled). The composer is for free text. Once
        every required question is answered through either channel, sending resolves the question.
      </p>
      {Object.entries(MODES).map(([key, m]) => (
        <ModeBlock key={key} modeKey={key} payload={m.payload} />
      ))}
    </div>
  );
}
