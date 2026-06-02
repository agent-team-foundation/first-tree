import type { ChatEngagementView, ChatSource, MeChatRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { GroupMode } from "./workspace/conversations/group-rows.js";
import { ConversationList, type RailFilter } from "./workspace/conversations/index.js";

/**
 * DEV-only visual review for the redesigned `ConversationList` (workspace
 * left rail). Renders the REAL component — header triad, `⚙` popover,
 * de-decorated rows, attention lines, muted avatars — against a seeded
 * react-query cache so it needs no backend.
 *
 * Mounted outside `<Layout>` (see `app.tsx`), so `useAuth()` resolves to
 * the app's provider with `agentId: null` (no redirect). A nested
 * `QueryClientProvider` with frozen, pre-seeded data drives the list; the
 * three triad views (All / Unread / Watching) are each seeded so the
 * primary filter is demoable. Gated by `import.meta.env.DEV`. Do NOT ship.
 */

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function row(overrides: Partial<MeChatRow>): MeChatRow {
  return {
    chatId: overrides.chatId ?? "preview",
    type: overrides.type ?? "direct",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "preview",
    topic: overrides.topic ?? null,
    participants: overrides.participants ?? [],
    participantCount: overrides.participantCount ?? overrides.participants?.length ?? 0,
    lastMessageAt: overrides.lastMessageAt ?? minutesAgo(8),
    lastMessagePreview: overrides.lastMessagePreview ?? null,
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    pendingQuestionAgentIds: overrides.pendingQuestionAgentIds ?? [],
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasOpenQuestion: overrides.chatHasOpenQuestion ?? false,
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
  };
}

function p(name: string, id: string): MeChatRow["participants"][number] {
  return { agentId: id, displayName: name, type: "agent", avatarColorToken: null, avatarImageUrl: null };
}

const KAEL = p("kael", "agent-kael");
const DESIGN = p("design-critique", "agent-design");
const MARKET = p("marketing-writer", "agent-market");
const RESEARCH = p("research", "agent-res");

// Attention rows (failed + needs-you) — pinned into the "Needs attention"
// bucket at the top by the list.
const ATTENTION_ROWS: MeChatRow[] = [
  row({
    chatId: "c-failed",
    title: "Deploy pipeline",
    participants: [p("platform", "agent-plat")],
    failedAgentIds: ["agent-plat"],
    lastMessageAt: minutesAgo(3),
    lastMessagePreview: "build step exited 1",
  }),
  row({
    chatId: "c-needs",
    title: "Release checklist",
    participants: [KAEL],
    chatHasOpenQuestion: true,
    lastMessageAt: minutesAgo(6),
    lastMessagePreview: "Should I cut the tag now?",
  }),
];

// Normal rows — read, unread, busy, group, single-line, github.
const NORMAL_ROWS: MeChatRow[] = [
  row({
    chatId: "c-unread",
    title: "Q2 hero copy",
    participants: [DESIGN],
    unreadMentionCount: 2,
    chatHasExplicitMentionToMe: true,
    lastMessageAt: minutesAgo(12),
    lastMessagePreview: "baixiaohang: can you take a look at the second variant?",
  }),
  row({
    chatId: "c-busy",
    title: "Log triage",
    participants: [RESEARCH],
    busyAgentIds: ["agent-res"],
    lastMessageAt: minutesAgo(1),
    lastMessagePreview: "Analyzing the last 24h of errors…",
  }),
  row({
    chatId: "c-read",
    title: "Refactor the auth flow",
    participants: [KAEL],
    lastMessageAt: minutesAgo(34),
    lastMessagePreview: "let's split the token service out first",
  }),
  row({
    chatId: "c-group",
    type: "group",
    title: "platform-trio",
    participants: [KAEL, DESIGN, MARKET],
    lastMessageAt: minutesAgo(52),
    lastMessagePreview: "design-critique: spacing nudge on the hero",
  }),
  row({
    chatId: "c-github",
    title: "PR repo 712: tighten rail density",
    source: "github",
    entityType: "pull_request",
    participants: [p("ci-bot", "agent-ci")],
    lastMessageAt: minutesAgo(96),
    lastMessagePreview: "CI green · 3 files changed",
  }),
  row({
    chatId: "c-single",
    title: "standup-notes",
    participants: [KAEL],
    lastMessageAt: minutesAgo(140),
    // No preview → single-line row (no em-dash placeholder).
    lastMessagePreview: null,
  }),
];

const WATCHING_ROWS: MeChatRow[] = [
  row({
    chatId: "c-watch-1",
    title: "PR repo 688: adapter retries",
    membershipKind: "watching",
    canReply: false,
    source: "github",
    entityType: "pull_request",
    participants: [p("reviewer", "agent-rev")],
    lastMessageAt: minutesAgo(20),
    lastMessagePreview: "awaiting review",
  }),
  row({
    chatId: "c-watch-2",
    title: "research squad",
    type: "group",
    membershipKind: "watching",
    canReply: false,
    participants: [RESEARCH, MARKET],
    lastMessageAt: minutesAgo(180),
    lastMessagePreview: "12 papers summarized this week",
  }),
];

const UNREAD_ROWS: MeChatRow[] = NORMAL_ROWS.filter((r) => r.unreadMentionCount > 0);

function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchInterval: false,
      },
    },
  });
  const page = (rows: MeChatRow[]) => ({ rows, nextCursor: null });
  // Triad views — keys mirror `ConversationList`'s queryKey shape exactly.
  client.setQueryData(["me", "chats", "all", "active", false, null, null], page([...ATTENTION_ROWS, ...NORMAL_ROWS]));
  client.setQueryData(["me", "chats", "unread", "active", false, null, null], page(UNREAD_ROWS));
  client.setQueryData(["me", "chats", "all", "active", true, null, null], page(WATCHING_ROWS));
  // Name-map source consumed by `useAgentNameMap` (empty is fine — the
  // preview doesn't surface participant chips).
  client.setQueryData(["managed-agents", "name-map"], []);
  return client;
}

export function ConversationListPreviewPage() {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const themeOverride = params.get("theme");
  useEffect(() => {
    if (themeOverride === "light" || themeOverride === "dark") {
      document.documentElement.classList.toggle("dark", themeOverride === "dark");
    }
  }, [themeOverride]);

  const [client] = useState(seededClient);
  const [selectedChatId, setSelectedChatId] = useState<string | null>("c-read");
  const [engagement, setEngagement] = useState<ChatEngagementView>("active");
  const [unread, setUnread] = useState(false);
  const [watching, setWatching] = useState(false);
  const [origin, setOrigin] = useState<ReadonlyArray<ChatSource>>([]);
  const [participants, setParticipants] = useState<ReadonlyArray<string>>([]);
  const [group, setGroup] = useState<GroupMode>("recency");

  const onRailFilterChange = (view: RailFilter): void => {
    setUnread(view === "unread");
    setWatching(view === "watching");
  };
  const onClearFilters = (): void => {
    setOrigin([]);
    setParticipants([]);
    setUnread(false);
    setWatching(false);
  };

  return (
    <QueryClientProvider client={client}>
      <div style={{ background: "var(--bg)", minHeight: "100vh", display: "flex" }}>
        <ConversationList
          selectedChatId={selectedChatId}
          onSelectChat={setSelectedChatId}
          onNewChat={() => setSelectedChatId("draft")}
          engagement={engagement}
          onEngagementChange={setEngagement}
          unread={unread}
          watching={watching}
          onRailFilterChange={onRailFilterChange}
          origin={origin}
          onOriginChange={setOrigin}
          participants={participants}
          onParticipantsChange={setParticipants}
          onClearFilters={onClearFilters}
          group={group}
          onGroupChange={setGroup}
        />
        <div style={{ flex: 1, padding: "var(--sp-6)" }}>
          <p className="text-body" style={{ color: "var(--fg-3)", maxWidth: 460 }}>
            DEV preview of the redesigned conversation list. The triad (All / Unread / Watching), the <code>⚙</code>{" "}
            popover (Scope / Origin / Group by), row selection, and theme are all live. Append{" "}
            <code className="mono">?theme=dark</code> to inspect dark mode.
          </p>
        </div>
        <ThemeToggleCorner />
      </div>
    </QueryClientProvider>
  );
}

function ThemeToggleCorner() {
  return (
    <div
      style={{
        position: "fixed",
        bottom: "var(--sp-4)",
        right: "var(--sp-4)",
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        padding: "var(--sp-1_5) var(--sp-2_5)",
        boxShadow: "var(--shadow-md)",
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
      }}
    >
      <span className="text-label mono" style={{ color: "var(--fg-3)" }}>
        theme
      </span>
      <button
        type="button"
        className="text-caption mono"
        onClick={() => {
          document.documentElement.classList.toggle("dark");
          window.localStorage.setItem("theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
        }}
        style={{
          padding: "var(--sp-1) var(--sp-2)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          background: "var(--bg-hover)",
          color: "var(--fg-2)",
          cursor: "pointer",
        }}
      >
        toggle
      </button>
    </div>
  );
}
