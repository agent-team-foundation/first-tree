import type { AskRequest, GithubEventCard } from "@first-tree/shared";
import { useState } from "react";
import { AskTakeover } from "../components/chat/ask-takeover.js";
import { GithubEventCardMessage } from "../components/chat/github-event-card.js";

/**
 * DEV-only visual review for `AskTakeover` plus narrow timeline overflow
 * fixtures. No backend / no auth — same gating as the other `/preview/*`
 * routes (DEV-only in `app.tsx`). Each ask mode renders the production card
 * inside a relative box (the card is an absolute scrim that fills it).
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
  "",
  "### Verification command",
  "```sh",
  "first-tree-staging tree verify --tree-path /Users/reviewer/first-tree-context/very-long-mobile-verification-worktree",
  "```",
].join("\n");

const SINGLE_PAYLOAD: AskRequest = {
  multiSelect: false,
  options: [
    { label: "Ship to 20%", description: "Proceed now — error budget is healthy and unblocks billing." },
    {
      label: "Hold 24h",
      description: "Bake over the weekend; billing slips a day.",
      preview: "# re-evaluate Monday 09:00",
    },
  ],
};
const MULTI_PAYLOAD: AskRequest = {
  multiSelect: true,
  options: [
    { label: "Web", description: "ship the web surface" },
    { label: "CLI", description: "ship the CLI surface" },
    {
      label: "API",
      description: "ship the public API",
      preview:
        "https://example.invalid/qa/mobile-ask-card-very-long-preview/endpoint?token=abcdefghijklmnopqrstuvwxyz0123456789&scope=read:write:admin&note=this-is-a-deliberately-very-long-single-token-preview-to-exercise-overflow-wrap-and-scroll-clipping",
    },
  ],
};

const COMMIT_SHA = "abcdef0123456789".repeat(3).slice(0, 40);
const COMMIT_CARD: GithubEventCard = {
  type: "github_event",
  reason: "subscribed",
  event: "commit_comment",
  action: "created",
  kind: "commit_commented",
  repository: "agent-team-foundation/first-tree",
  sender: "mobile-reviewer-with-a-long-handle",
  title: "Commit: Keep the mobile timeline inside its reading column",
  body: `Verification target ${"unbroken".repeat(30)}`,
  url: `https://github.com/agent-team-foundation/first-tree/commit/${COMMIT_SHA}`,
  entity: {
    type: "commit",
    key: `agent-team-foundation/first-tree@${COMMIT_SHA}`,
    url: `https://github.com/agent-team-foundation/first-tree/commit/${COMMIT_SHA}`,
  },
};

const MODES: { label: string; payload: AskRequest }[] = [
  { label: "options · single", payload: SINGLE_PAYLOAD },
  { label: "options · multi", payload: MULTI_PAYLOAD },
  { label: "free text", payload: { multiSelect: false } },
];

function ModeBlock({
  label,
  payload,
  height = 560,
  mobile = false,
}: {
  label: string;
  payload: AskRequest;
  height?: number;
  mobile?: boolean;
}) {
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
          height,
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
          mobile={mobile}
          onReply={(answer) =>
            setStatus(
              `Reply → ${answer.content.replace(/\n/g, " · ")}` +
                (answer.mentions.length > 0 ? ` · @${answer.mentions.length}` : "") +
                (answer.images.length > 0 ? ` · ${answer.images.length}🖼` : ""),
            )
          }
          onSkip={() => setStatus("Skipped → resolves the request with a skipped answer")}
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
        The ask body and the answer surface (options + Other) share one scroll region; only the Skip / Reply footer
        stays pinned, so Reply is reachable at any height. Both resolve the question: Reply sends the composed answer,
        Skip sends a skipped answer (there is no keep-it-open path).
      </p>
      {MODES.map((m) => (
        <ModeBlock key={m.label} label={m.label} payload={m.payload} />
      ))}

      <h2 className="mono text-caption font-semibold" style={{ color: "var(--fg-3)", textTransform: "uppercase" }}>
        cramped height — footer must stay reachable
      </h2>
      <p className="text-body" style={{ color: "var(--fg-3)", margin: "var(--sp-1) 0 var(--sp-4)" }}>
        A short box (the phone case): the answer surface no longer fits, so it scrolls inside the card while the Skip /
        Reply footer stays pinned and visible. Regression guard for the off-screen-button bug.
      </p>
      <ModeBlock label="options · single · short" payload={SINGLE_PAYLOAD} height={300} mobile />
      <ModeBlock label="options · multi · short" payload={MULTI_PAYLOAD} height={300} mobile />

      <h2
        className="mono text-caption font-semibold"
        style={{ color: "var(--fg-3)", textTransform: "uppercase", marginBottom: "var(--sp-2)" }}
      >
        GitHub commit overflow guard
      </h2>
      <div
        data-mobile-github-fixture
        style={{
          width: "100%",
          padding: "var(--sp-3)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          background: "var(--bg-raised)",
          overflow: "hidden",
        }}
      >
        <GithubEventCardMessage content={COMMIT_CARD} />
      </div>
    </div>
  );
}
