import type { MeChatRow } from "@first-tree/shared";
import { useEffect } from "react";
import { ChatRowAvatar } from "../components/chat/chat-row-avatar.js";

/**
 * DEV-only visual review for `ChatRowAvatar` + the surrounding row layout.
 *
 * Mounted outside `<Layout>` so it needs no auth / no react-router context —
 * mirrors the `/preview/context` page (see `context-preview.tsx`). Each
 * variant gets a real `MeChatRow`-shaped fixture and the production
 * `ChatRowAvatar` component is rendered against it; the surrounding
 * `<button>` mimics the actual conversation-list row's DOM so spacing,
 * typography, and the row's text-stack alignment are faithful to prod.
 *
 * Used to generate the static screenshots that ship with the chat-status-
 * icons design preview. Do NOT ship in prod — gated by `import.meta.env.DEV`
 * in `app.tsx`.
 */

const SELF_ID = "self-uuid";

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
    lastMessageAt: overrides.lastMessageAt ?? new Date().toISOString(),
    lastMessagePreview: overrides.lastMessagePreview ?? null,
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
  };
}

function participant(name: string, agentId?: string): MeChatRow["participants"][number] {
  return {
    agentId: agentId ?? `agent-${name.toLowerCase()}`,
    displayName: name,
    type: "agent",
    avatarColorToken: null,
    avatarImageUrl: null,
  };
}

const KAEL = participant("kael", "agent-kael");
const DESIGN = participant("design-critique", "agent-design");
const MARKET = participant("marketing-writer", "agent-market");
const RES = participant("research", "agent-res");
const SUPP = participant("support", "agent-supp");
const ARCH = participant("architect", "agent-arch");
const PLAT = participant("platform", "agent-plat");

const VARIANTS: Array<{ name: string; row: MeChatRow; subtitle?: string }> = [
  // ─── direct / single avatar ──────────────────────────────────────────────
  {
    name: "1-on-1 · idle",
    row: row({
      title: "kael",
      participants: [KAEL],
      lastMessagePreview: "Will pick this up after lunch.",
    }),
  },
  {
    name: "1-on-1 · working ring",
    row: row({
      title: "kael",
      participants: [KAEL],
      lastMessagePreview: "Analyzing logs from the last 24h…",
    }),
  },
  {
    name: "1-on-1 · unread(1)",
    row: row({
      title: "kael",
      participants: [KAEL],
      unreadMentionCount: 1,
      lastMessagePreview: "Done — see PR 422.",
    }),
  },
  {
    name: "1-on-1 · unread(12)",
    row: row({
      title: "kael",
      participants: [KAEL],
      unreadMentionCount: 12,
      lastMessagePreview: "Lots of context for you.",
    }),
  },
  {
    name: "1-on-1 · unread(99+)",
    row: row({
      title: "kael",
      participants: [KAEL],
      unreadMentionCount: 137,
      lastMessagePreview: "Daily digest backlog…",
    }),
  },
  {
    name: "1-on-1 · working + unread(3)",
    row: row({
      title: "kael",
      participants: [KAEL],
      unreadMentionCount: 3,
      lastMessagePreview: "Pulling the next batch now.",
    }),
  },
  {
    name: "1-on-1 · watcher (read-only)",
    row: row({
      title: "marketing-writer",
      participants: [MARKET],
      membershipKind: "watching",
      canReply: false,
      lastMessagePreview: "Watching · weekly digest landed",
    }),
  },
  // ─── group / composite avatar ────────────────────────────────────────────
  {
    name: "Group n=2",
    row: row({
      type: "group",
      title: "Q2 hero copy",
      participants: [KAEL, DESIGN],
      lastMessagePreview: "Kael: Two variants up for review.",
    }),
  },
  {
    name: "Group n=3 (T-split)",
    row: row({
      type: "group",
      title: "platform-trio",
      participants: [KAEL, DESIGN, MARKET],
      unreadMentionCount: 2,
      lastMessagePreview: "design-critique: spacing nudge on the hero",
    }),
  },
  {
    name: "Group n=4 (all visible)",
    row: row({
      type: "group",
      title: "research squad",
      participants: [KAEL, DESIGN, MARKET, RES],
      lastMessagePreview: "research: 12 papers summarized this week",
    }),
  },
  {
    name: "Group n=5 (+2 overflow)",
    row: row({
      type: "group",
      title: "platform-design",
      participants: [PLAT, ARCH, SUPP, KAEL, DESIGN],
      lastMessagePreview: "platform: shipped the new tokens spec",
    }),
  },
  {
    name: "Group n=10 (+7 overflow)",
    row: row({
      type: "group",
      title: "all-hands",
      participants: [KAEL, DESIGN, MARKET, RES, SUPP, ARCH, PLAT, KAEL, DESIGN, MARKET],
      unreadMentionCount: 4,
      lastMessagePreview: "all-hands kickoff in 5 minutes",
    }),
  },
];

export function ChatRowAvatarPreviewPage() {
  // `?freeze=1` pins the working ring at peak opacity so static
  // screenshots aren't caught mid-breath. The class is read by the
  // override rule at the bottom of this file.
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const freeze = params.get("freeze") === "1";
  const themeOverride = params.get("theme");
  useEffect(() => {
    // Push the `?theme=` override into `documentElement` so the page
    // matches the param even when `localStorage.theme` says otherwise.
    // Kept in an effect (not in render) so Strict Mode double-invokes
    // and SSR don't trip the side effect.
    if (themeOverride === "light" || themeOverride === "dark") {
      document.documentElement.classList.toggle("dark", themeOverride === "dark");
    }
  }, [themeOverride]);
  return (
    <div
      className={freeze ? "chat-row-avatar-preview--freeze" : undefined}
      style={{ background: "var(--bg)", minHeight: "100vh", padding: "var(--sp-6)" }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <header style={{ marginBottom: "var(--sp-6)" }}>
          <h1 className="text-title" style={{ color: "var(--fg)", marginBottom: "var(--sp-1)" }}>
            Chat Row Avatar · Visual Preview
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)" }}>
            DEV-only fixture covering every documented variant of the new conversation-list avatar slot. Toggle theme
            via the moon/sun in the corner.
          </p>
        </header>

        <div
          style={{
            display: "grid",
            gap: "var(--sp-4)",
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          }}
        >
          {VARIANTS.map((v) => (
            <PreviewCard key={v.name} name={v.name} row={v.row} />
          ))}
        </div>

        <ThemeToggleCorner />

        <style>{`
        .chat-row-avatar-preview--freeze .chat-row-avatar__working-ring {
          animation: none !important;
          opacity: 1 !important;
        }
      `}</style>
      </div>
    </div>
  );
}

function PreviewCard({ name, row }: { name: string; row: MeChatRow }) {
  const hasUnread = row.unreadMentionCount > 0;
  return (
    <div
      style={{
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        overflow: "hidden",
      }}
    >
      <div
        className="text-caption mono"
        style={{
          padding: "var(--sp-2) var(--sp-3)",
          color: "var(--fg-4)",
          background: "var(--bg-sunken)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        {name}
      </div>

      {/* Mimic the production conversation-list row geometry verbatim. */}
      <button
        type="button"
        className="w-full text-left flex items-center"
        style={{
          padding: "var(--sp-2) var(--sp-3)",
          gap: "var(--sp-2)",
          background: "transparent",
          borderLeft: "var(--hairline-bold) solid transparent",
          width: 320,
        }}
      >
        <ChatRowAvatar
          title={row.title}
          type={row.type}
          participants={row.participants}
          selfAgentId={SELF_ID}
          unreadCount={row.unreadMentionCount}
          failed={row.failedAgentIds.length > 0}
        />
        <div className="flex flex-col" style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-baseline" style={{ gap: 6 }}>
            <span
              className="truncate text-subtitle"
              style={{
                color: hasUnread ? "var(--fg)" : "var(--fg-2)",
                fontWeight: hasUnread ? 700 : 500,
                flex: 1,
                minWidth: 0,
              }}
            >
              {row.title}
            </span>
            <span className="mono text-caption shrink-0" style={{ color: "var(--fg-4)" }}>
              now
            </span>
          </div>
          <div
            className="truncate text-body"
            style={{
              color: hasUnread ? "var(--fg-2)" : "var(--fg-3)",
              marginTop: 2,
            }}
          >
            {row.lastMessagePreview ?? "—"}
          </div>
        </div>
      </button>
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
