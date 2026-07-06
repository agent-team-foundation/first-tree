import {
  type AgentChatStatus,
  type AgentChatStatusInput,
  buildAgentChatStatus,
  type ChatParticipantDetail,
  type LiveActivity,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { chatAgentStatusQueryKey } from "../api/agent-status.js";
import { ComposeStatusBar } from "../components/chat/compose-status-bar.js";

/**
 * DEV-only visual review for `ComposeStatusBar` — the working / failed rail
 * above the composer.
 *
 * The rail is `useQuery`-driven (the shared `/agent-status` query), so each
 * variant primes its own entry in a local `QueryClient` cache keyed by a unique
 * `chatId`; the production component is then rendered against it inside a box
 * that mimics the real composer column width, so spacing, truncation, and the
 * goal → means → ticker order are faithful to prod. No backend / no auth — same
 * gating as `/preview/chat-row-avatar` (DEV-only in `app.tsx`).
 *
 * Covers the spec acceptance: goal-first working line, live-action means with a
 * per-kind icon, markdown stripped, long goal truncates while means + ticker
 * survive, no-prose fallback (means leads), path-arg basename, failed, and the
 * multi-agent +N fold.
 */

/** ISO timestamp `secondsAgo` in the past — drives the live elapsed ticker so a
 *  screenshot reads e.g. "· 12s" instead of "· 0s". */
function ago(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function agent(agentId: string, displayName: string): ChatParticipantDetail {
  return {
    agentId,
    role: "member",
    mode: "auto",
    joinedAt: ago(3600),
    name: displayName,
    displayName,
    type: "agent",
    avatarColorToken: null,
    avatarImageUrl: null,
  };
}

/** A working status with a live activity, built through the real constructor so
 *  `main` stays derived (the schema invariant holds, same as prod). */
function working(agentId: string, activity: Omit<LiveActivity, "agentId">): AgentChatStatus {
  return build({ agentId, working: true, activity: { agentId, ...activity } });
}

function build(over: Partial<AgentChatStatusInput> & { agentId: string }): AgentChatStatus {
  return buildAgentChatStatus({
    reachable: true,
    errored: false,
    working: false,
    engagement: "active",
    ...over,
  });
}

const DEV = agent("agent-dev", "gandy-developer");
const NOVA = agent("agent-nova", "nova");
const RESEARCH = agent("agent-res", "research");

type Variant = {
  name: string;
  subtitle: string;
  chatId: string;
  agents: ChatParticipantDetail[];
  statuses: AgentChatStatus[];
};

const VARIANTS: Variant[] = [
  {
    name: "working · goal + tool (the ideal line)",
    subtitle: "goal leads, live tool follows with a 🔧 icon, ticker last",
    chatId: "v-goal-tool",
    agents: [DEV],
    statuses: [
      working("agent-dev", {
        kind: "tool_call",
        label: "Bash",
        detail: "npm test",
        turnText: "Reworking the compose status bar so the goal shows first",
        startedAt: ago(12),
      }),
    ],
  },
  {
    name: "working · markdown in goal (stripped)",
    subtitle: "raw turnText `issue 669` / **hex-color** renders as plain text",
    chatId: "v-markdown",
    agents: [DEV],
    statuses: [
      working("agent-dev", {
        kind: "tool_call",
        label: "Read",
        detail: "agent-status-view.ts",
        turnText: "Reviewing `issue 669` — the **hex-color** check trips on `#NNN`",
        startedAt: ago(7),
      }),
    ],
  },
  {
    name: "working · long goal (truncates)",
    subtitle: "goal truncates first; name, tool, and ticker always survive",
    chatId: "v-long",
    agents: [DEV],
    statuses: [
      working("agent-dev", {
        kind: "tool_call",
        label: "Edit",
        detail: "compose-status-bar.tsx",
        turnText:
          "Investigating why the assistant-text narration was burying the live tool action on the rail, then flipping the priority so the goal leads and the tool trails, and finally width-capping the goal so it never crowds out the ticker",
        startedAt: ago(48),
      }),
    ],
  },
  {
    name: "working · long multi-line goal (expand card)",
    subtitle: "goal truncates on the rail; the ⌃ chevron opens the full turnText card (click to test)",
    chatId: "v-expand",
    agents: [DEV],
    statuses: [
      working("agent-dev", {
        kind: "tool_call",
        label: "Bash",
        detail: "pnpm typecheck",
        turnText: "Reworking the compose status bar so a long narration can expand to its full multi-line form",
        turnTextFull:
          "Reworking the compose status bar so a long narration can expand to its full multi-line form.\n\nPlan:\n1. Server derives a newline-preserving turnTextFull (capped at 2000), only when it carries more than the one-line goal.\n2. The rail keeps its single line; a dedicated ⌃ chevron opens a floating card.\n3. The card floats over the stream (absolute, out of flow) so the live ~1s refresh never reflows the conversation.",
        startedAt: ago(23),
      }),
    ],
  },
  {
    name: "working · no prose yet (means leads)",
    subtitle: "turnText absent (opened with a tool) → tool leads, line not blank",
    chatId: "v-no-goal",
    agents: [DEV],
    statuses: [working("agent-dev", { kind: "tool_call", label: "Read", detail: "src/app.tsx", startedAt: ago(2) })],
  },
  {
    name: "working · thinking",
    subtitle: "goal + 🧠 Thinking",
    chatId: "v-thinking",
    agents: [NOVA],
    statuses: [
      working("agent-nova", {
        kind: "thinking",
        label: "Thinking",
        turnText: "Working out the rollout plan",
        startedAt: ago(4),
      }),
    ],
  },
  {
    name: "working · writing prose (no redundant 'Writing')",
    subtitle: "the prose IS the goal — the means segment is suppressed",
    chatId: "v-writing",
    agents: [NOVA],
    statuses: [
      working("agent-nova", {
        kind: "assistant_text",
        label: "Writing",
        detail: "Here's the summary of what I changed and why",
        turnText: "Here's the summary of what I changed and why",
        startedAt: ago(3),
      }),
    ],
  },
  {
    name: "working · path arg → basename",
    subtitle: "a lone filesystem path collapses to its basename",
    chatId: "v-path",
    agents: [DEV],
    statuses: [
      working("agent-dev", {
        kind: "tool_call",
        label: "Read",
        detail: "packages/web/src/app.tsx",
        turnText: "Wiring the dev preview route",
        startedAt: ago(1),
      }),
    ],
  },
  {
    name: "failed",
    subtitle: "red dot + 'failed'; the row jumps to the timeline ErrorRow",
    chatId: "v-failed",
    agents: [RESEARCH],
    statuses: [build({ agentId: "agent-res", errored: true })],
  },
  {
    name: "multi-agent · failed lead + working others (+N)",
    subtitle: "failure preempts the lead; others fold behind +N",
    chatId: "v-multi",
    agents: [DEV, NOVA, RESEARCH],
    statuses: [
      build({ agentId: "agent-res", errored: true }),
      working("agent-dev", {
        kind: "tool_call",
        label: "Bash",
        detail: "pnpm typecheck",
        turnText: "Verifying the build",
        startedAt: ago(9),
      }),
      working("agent-nova", { kind: "thinking", label: "Thinking", turnText: "Drafting the plan", startedAt: ago(5) }),
    ],
  },
];

export function ComposeStatusBarPreviewPage() {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const themeOverride = params.get("theme");
  useEffect(() => {
    if (themeOverride === "light" || themeOverride === "dark") {
      document.documentElement.classList.toggle("dark", themeOverride === "dark");
    }
  }, [themeOverride]);

  // One client, primed once. staleTime Infinity + no refetch-on-mount keeps the
  // fixtures pinned (there's no backend to refetch from).
  const [client] = useState(() => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    for (const v of VARIANTS) qc.setQueryData(chatAgentStatusQueryKey(v.chatId), v.statuses);
    return qc;
  });

  return (
    <QueryClientProvider client={client}>
      {/* Hidden timeline anchors so working/failed rows read as jumpable
          (matching prod), without a real timeline mounted. */}
      <div style={{ display: "none" }}>
        {VARIANTS.flatMap((v) =>
          v.statuses.map((s) =>
            s.main === "working" ? (
              <div key={`w-${v.chatId}-${s.agentId}`} data-working-agent={s.agentId} />
            ) : s.main === "failed" ? (
              <div key={`f-${v.chatId}-${s.agentId}`} data-error-agent={s.agentId} />
            ) : null,
          ),
        )}
      </div>
      <div style={{ background: "var(--bg)", minHeight: "100vh", padding: "var(--sp-6)" }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <h1 className="text-title" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1)" }}>
            ComposeStatusBar — working / failed rail
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-6)" }}>
            DEV preview. Each card mimics the composer column; the real component renders against a primed status
            fixture. Append <code>?theme=dark</code> to flip the theme.
          </p>
          <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
            {VARIANTS.map((v) => (
              <section key={v.chatId} className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                <div>
                  <div className="text-label" style={{ color: "var(--fg-2)" }}>
                    {v.name}
                  </div>
                  <div className="text-caption" style={{ color: "var(--fg-4)" }}>
                    {v.subtitle}
                  </div>
                </div>
                {/* Composer-column mimic: same max-width + raised surface as the
                    real chat-bottom composer card. */}
                <div
                  style={{
                    maxWidth: "clamp(55rem, 75%, 70rem)",
                    background: "var(--bg-raised)",
                    border: "var(--hairline) solid var(--border)",
                    borderRadius: 6,
                    padding: "var(--sp-2) var(--sp-3)",
                  }}
                >
                  <ComposeStatusBar chatId={v.chatId} agents={v.agents} />
                  <div
                    className="text-caption"
                    style={{ color: "var(--fg-4)", paddingTop: "var(--sp-1)" }}
                    aria-hidden="true"
                  >
                    Message {v.agents[0]?.displayName ?? "the team"}…
                  </div>
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </QueryClientProvider>
  );
}
