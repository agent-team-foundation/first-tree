import {
  type AgentChatStatus,
  type AgentChatStatusInput,
  buildAgentChatStatus,
  type ChatParticipantDetail,
  type CurrentTurnNarrations,
  type LiveActivity,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { chatAgentStatusQueryKey } from "../api/agent-status.js";
import { chatCurrentTurnNarrationsQueryKey } from "../api/sessions.js";
import { ComposeStatusBar } from "../components/chat/compose-status-bar.js";

/**
 * DEV-only visual review for the connected composer status section.
 *
 * The rail is `useQuery`-driven (the shared `/agent-status` query), so each
 * variant primes its own entry in a local `QueryClient` cache keyed by a unique
 * `chatId`; the production component is then rendered against it inside a box
 * that mimics the real composer column width, so spacing, truncation, and the
 * compact → inline-detail structure is faithful to prod. No backend / no auth — same
 * gating as `/preview/chat-row-avatar` (DEV-only in `app.tsx`).
 *
 * Covers one-line narration, tool-only fallback, complete Markdown output,
 * failure priority, and multiple agents inside one connected surface.
 */

/** ISO timestamp `secondsAgo` in the past — keeps multi-agent priority realistic. */
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
  narrations?: CurrentTurnNarrations;
};

const VARIANTS: Variant[] = [
  {
    name: "working · narration + tool",
    subtitle: "text leads; the redundant current tool disappears from expanded output",
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
    name: "working · markdown in narration (stripped)",
    subtitle: "compact preview is plain text; expanded output keeps Markdown structure",
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
    name: "working · long narration",
    subtitle: "the compact row is one line; the connected detail keeps the complete text",
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
    name: "working · complete multiline narration",
    subtitle: "expanded output reconstructs every current-turn assistant_text chunk without a visible cap",
    chatId: "v-expand",
    agents: [DEV],
    statuses: [
      working("agent-dev", {
        kind: "tool_call",
        label: "Bash",
        detail: "pnpm typecheck",
        turnText: "Reworking the compose status bar so a long narration can expand to its full multi-line form",
        startedAt: ago(23),
      }),
    ],
    narrations: [
      {
        agentId: "agent-dev",
        afterSeq: 20,
        latestSeq: 24,
        text: "Reworking the compose status bar so a long narration can expand to its full multi-line form.\n\nPlan:\n1. Keep the token total above the connected composer.\n2. Reconstruct every assistant-text chunk for the current turn.\n3. Render the complete Markdown inline without duplicating tool calls.",
      },
    ],
  },
  {
    name: "working · no narration yet",
    subtitle: "when a turn opens with a tool, the tool becomes the concise fallback summary",
    chatId: "v-no-goal",
    agents: [DEV],
    statuses: [working("agent-dev", { kind: "tool_call", label: "Read", detail: "src/app.tsx", startedAt: ago(2) })],
  },
  {
    name: "working · thinking",
    subtitle: "narration leads; Thinking is only a fallback before text exists",
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
    subtitle: "the prose is already the update, so a redundant Writing row is suppressed",
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
    subtitle: "failure preempts ordinary working output in the connected status row",
    chatId: "v-failed",
    agents: [RESEARCH],
    statuses: [build({ agentId: "agent-res", errored: true })],
  },
  {
    name: "multi-agent · one connected detail",
    subtitle: "failure leads; expanded output lists active agents without nested cards",
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
    for (const v of VARIANTS) {
      qc.setQueryData(chatAgentStatusQueryKey(v.chatId), v.statuses);
      qc.setQueryData(
        chatCurrentTurnNarrationsQueryKey(v.chatId),
        v.narrations ??
          v.statuses.flatMap((status, index) => {
            const text = status.activity?.turnText;
            return text ? [{ agentId: status.agentId, afterSeq: 0, latestSeq: index + 1, text }] : [];
          }),
      );
    }
    return qc;
  });

  return (
    <QueryClientProvider client={client}>
      <div style={{ background: "var(--bg)", minHeight: "100vh", padding: "var(--sp-6)" }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <h1 className="text-title" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1)" }}>
            ComposeStatusBar — connected current output
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
                <div className="composer-stack" style={{ maxWidth: "clamp(55rem, 75%, 70rem)" }}>
                  <ComposeStatusBar chatId={v.chatId} agents={v.agents} />
                  <div
                    className="composer-card text-caption"
                    data-composer-editor
                    style={{
                      color: "var(--fg-4)",
                      padding: "var(--sp-3)",
                      background: "var(--bg-raised)",
                      border: "var(--hairline) solid var(--border)",
                    }}
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
