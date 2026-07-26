import type { ChatEngagementView, ChatSource, MeChatPriorityRows, MeChatRow } from "@first-tree/shared";
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
    description: overrides.description ?? null,
    participants: overrides.participants ?? [],
    participantCount: overrides.participantCount ?? overrides.participants?.length ?? 0,
    lastMessageAt: overrides.lastMessageAt ?? minutesAgo(8),
    lastMessagePreview: overrides.lastMessagePreview ?? null,
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
    pinnedAt: overrides.pinnedAt ?? null,
    activityAt: overrides.activityAt ?? null,
  };
}

function p(name: string, id: string): MeChatRow["participants"][number] {
  return { agentId: id, displayName: name, type: "agent", avatarColorToken: null, avatarImageUrl: null };
}

const NOVA = p("nova", "agent-nova");
const DESIGN = p("design-critique", "agent-design");
const MARKET = p("marketing-writer", "agent-market");
const RESEARCH = p("research", "agent-res");

// Attention rows (failed + explicit mention) — pinned into the "Needs attention"
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
    chatId: "c-mention",
    title: "Release checklist",
    participants: [NOVA],
    unreadMentionCount: 1,
    chatHasExplicitMentionToMe: true,
    pinnedAt: null,
    activityAt: null,
    lastMessageAt: minutesAgo(6),
    lastMessagePreview: "baixiaohang: please review the tag plan.",
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
    pinnedAt: null,
    activityAt: null,
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
    participants: [NOVA],
    lastMessageAt: minutesAgo(34),
    lastMessagePreview: "let's split the token service out first",
    // Pinned so the preview demonstrates the Pinned group + the row Unpin action.
    pinnedAt: minutesAgo(200),
  }),
  row({
    chatId: "c-group",
    type: "group",
    title: "platform-trio",
    participants: [NOVA, DESIGN, MARKET],
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
    participants: [NOVA],
    lastMessageAt: minutesAgo(140),
    // No preview → single-line row (no em-dash placeholder).
    lastMessagePreview: null,
  }),
  row({
    chatId: "c-group-unread",
    type: "group",
    title: "release-train",
    participants: [NOVA, DESIGN, RESEARCH],
    unreadMentionCount: 5,
    chatHasExplicitMentionToMe: true,
    pinnedAt: null,
    activityAt: null,
    lastMessageAt: minutesAgo(70),
    lastMessagePreview: "research: cut RC2?",
  }),
  row({
    chatId: "c-watch-inline",
    title: "PR repo 701: docs pass",
    membershipKind: "watching",
    canReply: false,
    source: "github",
    entityType: "pull_request",
    participants: [p("reviewer", "agent-rev")],
    lastMessageAt: minutesAgo(115),
    lastMessagePreview: "watching this one",
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

// A couple of archived chats so Status = Archived / All show data (and so
// "Reset all" visibly restores the active list rather than leaving a blank).
const ARCHIVED_ROWS: MeChatRow[] = [
  row({
    chatId: "c-arch-1",
    title: "Q1 launch retro",
    participants: [DESIGN],
    engagementStatus: "archived",
    lastMessageAt: minutesAgo(4000),
    lastMessagePreview: "wrapped up, archiving the thread",
  }),
  row({
    chatId: "c-arch-2",
    title: "PR repo 540: old migration",
    source: "github",
    entityType: "pull_request",
    participants: [p("ci-bot", "agent-ci")],
    engagementStatus: "archived",
    lastMessageAt: minutesAgo(7200),
    lastMessagePreview: "merged + archived",
  }),
];

const ACTIVE_ALL: MeChatRow[] = [...ATTENTION_ROWS, ...NORMAL_ROWS];
const bySource = (rows: MeChatRow[], src: ChatSource): MeChatRow[] =>
  rows.filter((r) => (r.source ?? "manual") === src);

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
  // `ConversationList` reads via `useInfiniteQuery`, so seeded cache entries
  // must be the `InfiniteData` shape (`{ pages, pageParams }`). Model the server
  // priority projection so the preview shows the Needs attention + Pinned groups
  // (attention = failed / open-request rows; pinned = pinned rows not in
  // attention). Ordinary rows stay additive; the component de-dupes them.
  const priorityFrom = (rows: MeChatRow[]): MeChatPriorityRows => {
    const attention = rows.filter((r) => r.failedAgentIds.length > 0 || r.openRequestCount > 0);
    const attentionIds = new Set(attention.map((r) => r.chatId));
    const pinned = rows.filter((r) => r.pinnedAt !== null && !attentionIds.has(r.chatId));
    return { attention, pinned };
  };
  const page = (rows: MeChatRow[]) => ({
    pages: [{ rows, nextCursor: null, priorityRows: priorityFrom(rows) }],
    pageParams: [undefined],
  });
  // Triad views — keys mirror `ConversationList`'s queryKey shape exactly:
  // ["me","chats", filter, engagement, watching, origin, with].
  client.setQueryData(["me", "chats", "all", "active", false, null, null], page(ACTIVE_ALL));
  client.setQueryData(["me", "chats", "unread", "active", false, null, null], page(UNREAD_ROWS));
  client.setQueryData(["me", "chats", "all", "active", true, null, null], page(WATCHING_ROWS));
  // Status (engagement) views — so switching Status in ⚙ shows data and
  // "Reset all" visibly returns to the active list.
  client.setQueryData(["me", "chats", "all", "archived", false, null, null], page(ARCHIVED_ROWS));
  client.setQueryData(["me", "chats", "all", "all", false, null, null], page([...ACTIVE_ALL, ...ARCHIVED_ROWS]));
  // Source (origin) single-select views — so picking Manual / GitHub in ⚙
  // narrows visibly instead of blanking.
  client.setQueryData(["me", "chats", "all", "active", false, "manual", null], page(bySource(ACTIVE_ALL, "manual")));
  client.setQueryData(["me", "chats", "all", "active", false, "github", null], page(bySource(ACTIVE_ALL, "github")));
  // Name-map source consumed by `useAgentNameMap` (empty is fine). The ⚙
  // Participants picker is search-only: its live typeahead results + selected
  // chips need a backend, so this offline preview only demonstrates the search
  // input + the "Type to search people." empty state — results, chips, and the
  // filtered/no-match/error branches are covered by the DOM tests.
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
    // Mirror the shipped `nextParamsForClearFilters`: "Reset" resets the
    // popover's OWN dimensions — Source, Participants, and Status (engagement →
    // default "active") — which are exactly what the gear badge counts. The
    // header triad (All / Unread / Watching) is a separate control and is left
    // untouched.
    setOrigin([]);
    setParticipants([]);
    setEngagement("active");
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
        <div style={{ flex: 1, padding: "var(--sp-6)", maxWidth: 560 }}>
          <h2 className="text-title" style={{ color: "var(--fg)", marginBottom: "var(--sp-1)" }}>
            Row-state legend
          </h2>
          <p className="text-body" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-4)" }}>
            Every row-level signal lives on the row now (no avatar corner badge). Each mock chat in the default{" "}
            <strong>All</strong> view demonstrates one state — match the title below to what you see. Triad,{" "}
            <code>⚙</code> filter, Group ▾, selection and theme are all live; append{" "}
            <code className="mono">?theme=dark</code> for dark mode.
          </p>
          <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
            <LegendRow
              chat="Deploy pipeline"
              state="agent failed"
              how="red ! badge on avatar corner (pinned to Needs attention)"
            />
            <LegendRow
              chat="Release checklist"
              state="needs your reply"
              how="amber ? badge on avatar corner (pinned)"
            />
            <LegendRow
              chat="Q2 hero copy"
              state="unread @mention"
              how="red dot on avatar corner (IM-style) + bold title"
            />
            <LegendRow chat="release-train" state="group + unread" how="composite avatar + corner red dot + bold" />
            <LegendRow chat="Log triage" state="agent working" how="green activity dots in place of time" />
            <LegendRow chat="Refactor the auth flow" state="selected" how="green row tint + green left bar" />
            <LegendRow chat="platform-trio" state="group chat" how="split/composite avatar" />
            <LegendRow chat="PR repo 701 / 688" state="watching (read-only)" how="neutral eye glyph before time" />
            <LegendRow chat="standup-notes" state="no preview" how="collapses to a single line" />
          </div>
          <p className="text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-4)" }}>
            Status (Active/Archived/All) + Source live in the ⚙ filter; picking a non-Active Status shows a count badge
            on ⚙, and <strong>Reset</strong> clears the ⚙ filters back to default (the header triad is left as-is).
          </p>
        </div>
        <ThemeToggleCorner />
      </div>
    </QueryClientProvider>
  );
}

function LegendRow({ chat, state, how }: { chat: string; state: string; how: string }) {
  return (
    <div className="surface-raised" style={{ padding: "var(--sp-2) var(--sp-2_5)" }}>
      <div className="flex items-baseline" style={{ gap: "var(--sp-2)" }}>
        <span className="text-subtitle" style={{ color: "var(--fg)" }}>
          {chat}
        </span>
        <span className="text-label" style={{ color: "var(--fg-2)" }}>
          — {state}
        </span>
      </div>
      <div className="text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
        {how}
      </div>
    </div>
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
