import type { AskRequest } from "@first-tree/shared";
import { useState } from "react";
import { AskTakeover } from "../components/chat/ask-takeover.js";

/**
 * DEV-only visual review for `AskTakeover` — the pop-up answer card for a
 * `format="request"` ask. No backend / no auth — same gating as the other
 * `/preview/*` routes (DEV-only in `app.tsx`). Each mode renders the production
 * card inside a relative box (the card is an absolute scrim that fills it).
 */

const BODY = [
  "## Ship the rollout to 20% now, or hold for another 24h?",
  "",
  "Rollout has sat at `5%` for 24h with the error rate flat and no new Sentry groups. Holding buys weekend bake",
  "time but delays the dependent `billing` migration gated on this.",
  "",
  "### What I'd weigh",
  "- Error budget is healthy; nothing in the dashboards argues against proceeding.",
  "- The billing migration team is waiting on 20% before they cut over.",
].join("\n");

const MODES: Record<string, { label: string; payload: AskRequest }> = {
  single: {
    label: "options · single",
    payload: {
      multiSelect: false,
      options: [
        { label: "Ship to 20%", description: "Proceed now — error budget is healthy and unblocks billing." },
        {
          label: "Hold 24h",
          description: "Bake over the weekend; billing slips a day.",
          preview: "# re-evaluate Monday 09:00",
        },
      ],
    },
  },
  multi: {
    label: "options · multi",
    payload: {
      multiSelect: true,
      options: [
        { label: "Web", description: "ship the web surface" },
        { label: "CLI", description: "ship the CLI surface" },
        { label: "API", description: "ship the public API" },
      ],
    },
  },
  free: { label: "free text", payload: { multiSelect: false } },
};

function ModeBlock({ label, payload }: { label: string; payload: AskRequest }) {
  const [status, setStatus] = useState<string | null>(null);
  return (
    <section style={{ marginBottom: "var(--sp-6)" }}>
      <h2 className="mono text-caption font-semibold" style={{ color: "var(--fg-3)", textTransform: "uppercase" }}>
        {label}
      </h2>
      <div
        style={{
          position: "relative",
          marginTop: "var(--sp-2)",
          height: 560,
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <AskTakeover
          body={BODY}
          payload={payload}
          askerName="deploy-agent"
          onReply={(content) => setStatus(`Reply → ${content.replace(/\n/g, " · ")}`)}
          onSkip={() => setStatus("Skipped (open-request persists)")}
        />
      </div>
      {status ? (
        <div className="mono text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1_5)" }}>
          {status}
        </div>
      ) : null}
    </section>
  );
}

export function RequestDockPreviewPage() {
  return (
    <div style={{ padding: "var(--sp-6)", background: "var(--bg-sunken)", minHeight: "100vh" }}>
      <h1 className="text-subtitle font-semibold" style={{ marginBottom: "var(--sp-1)" }}>
        AskTakeover preview
      </h1>
      <p className="text-body" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-4)" }}>
        The ask body scrolls; options + Other + actions stay fixed below. Reply resolves the question; Skip dismisses it
        for now (the open-request persists).
      </p>
      {Object.entries(MODES).map(([key, m]) => (
        <ModeBlock key={key} label={m.label} payload={m.payload} />
      ))}
    </div>
  );
}
