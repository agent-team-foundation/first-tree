import { buildAgentChatStatus, type ChatParticipantDetail } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatAgentStatusQueryKey } from "../../../api/agent-status.js";

const mountedAnchors = new Set<string>();

function participant(agentId: string, displayName: string): ChatParticipantDetail {
  return {
    agentId,
    role: "member",
    mode: "speaker",
    joinedAt: "2026-05-28T00:00:00.000Z",
    name: displayName.toLowerCase(),
    displayName,
    type: "autonomous",
    avatarColorToken: "hue-1",
    avatarImageUrl: null,
  };
}

function renderWithStatus(ui: ReactElement): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
    },
  });
  client.setQueryData(chatAgentStatusQueryKey("chat-1"), [
    buildAgentChatStatus({
      agentId: "failed",
      reachable: true,
      errored: true,
      needsYou: false,
      working: false,
      engagement: "active",
    }),
    buildAgentChatStatus({
      agentId: "needs",
      reachable: true,
      errored: false,
      needsYou: true,
      working: false,
      engagement: "active",
    }),
    buildAgentChatStatus({
      agentId: "working",
      reachable: true,
      errored: false,
      needsYou: false,
      working: true,
      engagement: "active",
      activity: {
        agentId: "working",
        kind: "tool_call",
        label: "Bash",
        detail: "pnpm test",
        startedAt: new Date(Date.now() - 12_000).toISOString(),
      },
    }),
    buildAgentChatStatus({
      agentId: "thinking",
      reachable: true,
      errored: false,
      needsYou: false,
      working: true,
      engagement: "active",
      activity: {
        agentId: "thinking",
        kind: "thinking",
        label: "Thinking",
        startedAt: new Date(Date.now() - 2_000).toISOString(),
      },
    }),
    buildAgentChatStatus({
      agentId: "writer",
      reachable: true,
      errored: false,
      needsYou: false,
      working: true,
      engagement: "active",
      activity: {
        agentId: "writer",
        kind: "assistant_text",
        label: "Assistant",
        detail: "Drafting a concise answer for the operator",
        turnText: "I am checking the failing test output",
        startedAt: new Date(Date.now() - 4_000).toISOString(),
      },
    }),
    buildAgentChatStatus({
      agentId: "idle",
      reachable: true,
      errored: false,
      needsYou: false,
      working: false,
      engagement: "none",
    }),
    buildAgentChatStatus({
      agentId: "offline",
      reachable: false,
      errored: false,
      needsYou: false,
      working: false,
      engagement: "none",
    }),
  ]);

  return renderToStaticMarkup(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("chat status surfaces render states", () => {
  beforeEach(() => {
    vi.resetModules();
    mountedAnchors.clear();
    mountedAnchors.add("failed:failed");
    mountedAnchors.add("needs_you:needs");
    mountedAnchors.add("working:working");
    vi.doMock("../../../lib/use-mounted-anchors.js", () => ({
      isJumpable: (mounted: ReadonlySet<string>, main: string, agentId: string) => mounted.has(`${main}:${agentId}`),
      useMountedAnchors: () => mountedAnchors,
    }));
    vi.doMock("../../../api/sessions.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../../api/sessions.js")>();
      return { ...original, suspendSession: vi.fn(async () => ({ ok: true })) };
    });
  });

  it("renders the sidebar status panel rows, status pills, working chip, and pause action", async () => {
    const { AgentStatusPanel } = await import("../agent-status-panel.js");
    const agents = [
      participant("failed", "Failed Agent"),
      participant("needs", "Needs Agent"),
      participant("working", "Working Agent"),
      participant("idle", "Idle Agent"),
      participant("offline", "Offline Agent"),
    ];

    const html = renderWithStatus(
      <AgentStatusPanel chatId="chat-1" agents={agents} canManage={() => true} order="priority" />,
    );

    expect(html).toContain("Failed Agent");
    expect(html).toContain("Needs reply");
    expect(html).toContain("Working Agent");
    expect(html).toContain("Working");
    expect(html).toContain("Bash");
    expect(html).toContain("Pause");
    expect(html).toContain("Idle Agent");
    expect(html).toContain("Offline Agent");
  });

  it("renders the compose rail lead with active agents and hides when all statuses are quiet", async () => {
    const { ComposeStatusBar } = await import("../compose-status-bar.js");
    const agents = [
      participant("failed", "Failed Agent"),
      participant("needs", "Needs Agent"),
      participant("working", "Working Agent"),
      participant("thinking", "Thinking Agent"),
      participant("writer", "Writer Agent"),
      participant("idle", "Idle Agent"),
    ];

    const html = renderWithStatus(<ComposeStatusBar chatId="chat-1" agents={agents} />);
    expect(html).toContain("Failed Agent");
    expect(html).toContain("failed");
    expect(html).toContain("+4");

    const quietClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false, staleTime: Infinity } },
    });
    quietClient.setQueryData(chatAgentStatusQueryKey("chat-quiet"), [
      buildAgentChatStatus({
        agentId: "idle",
        reachable: true,
        errored: false,
        needsYou: false,
        working: false,
        engagement: "none",
      }),
    ]);
    const quiet = renderToStaticMarkup(
      <QueryClientProvider client={quietClient}>
        <ComposeStatusBar chatId="chat-quiet" agents={[participant("idle", "Idle Agent")]} />
      </QueryClientProvider>,
    );
    expect(quiet).toBe("");
  });
});
