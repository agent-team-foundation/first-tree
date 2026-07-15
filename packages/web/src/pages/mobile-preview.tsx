import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowRight,
  CircleUserRound,
  type LucideIcon,
  Mail,
  MessageSquareText,
  MonitorCog,
  Palette,
  Pin,
  Plus,
  Search,
  UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { AskTakeover } from "../components/chat/ask-takeover.js";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import { MobileCardActionsMenu, type MobileChatAction, MobileSwipeCard } from "./mobile/chat-card-actions.js";
import {
  MobilePage,
  MobileSection,
  MobileSegmentedControl,
  MobileSignalChip,
  mobileAccentColor,
  mobileCardStyle,
} from "./mobile/components.js";
import type { MobileChatSignal } from "./mobile/data.js";

type PreviewTab = "now" | "chat" | "team" | "me";
type ChatFilter = "all" | "attention" | "watching";

type MockMessage = {
  author: string;
  role: "human" | "agent";
  body: string;
  time: string;
};

type MockChat = {
  id: string;
  title: string;
  time: string;
  owner: string;
  signal: MobileChatSignal;
  preview: string;
  summary: string;
  watching: boolean;
  messages: MockMessage[];
};

type MockPerson = {
  id: string;
  name: string;
  role: string;
  status: string;
  tone: "working" | "idle" | "offline";
};

const MOCK_CHATS: MockChat[] = [
  {
    id: "release-readiness",
    title: "Release readiness",
    time: "2m",
    owner: "gandy-coder",
    signal: { tone: "needs-you", label: "Needs your answer", rank: 0, attention: true },
    preview: "Review the mobile Phase 1 PR and decide whether to keep the mock preview in the branch.",
    summary:
      "The mobile shell is ready for review. The remaining decision is whether the no-login mock preview stays as a dev-only reviewer surface.",
    watching: false,
    messages: [
      {
        author: "gandy2025",
        role: "human",
        body: "I am outside. I need to open this from my phone without fighting login.",
        time: "16:45",
      },
      {
        author: "gandy-coder",
        role: "agent",
        body: "I added a frontend-only mock route with the same first-phase mobile surfaces and no server dependency.",
        time: "16:47",
      },
    ],
  },
  {
    id: "visual-qa",
    title: "Visual QA",
    time: "18m",
    owner: "design-review",
    signal: { tone: "unread", label: "Unread", rank: 2, attention: true },
    preview: "Check 320, 375, 390, 430, and 768 widths for tab bar stability and text wrapping.",
    summary:
      "The mobile screenshots cover the required small-phone widths plus tablet. The top risk is dense rows becoming too cramped below 360.",
    watching: true,
    messages: [
      {
        author: "design-review",
        role: "agent",
        body: "The Now page hierarchy is clear. Chat detail still needs real composer behavior in a later phase.",
        time: "16:12",
      },
      {
        author: "gandy-coder",
        role: "agent",
        body: "Phase 1 keeps the daily work surface narrow: status, chat list, team roster, account basics.",
        time: "16:18",
      },
    ],
  },
  {
    id: "context-docs",
    title: "Context docs pass",
    time: "44m",
    owner: "docs",
    signal: { tone: "working", label: "Working now", rank: 3, attention: false },
    preview: "Tighten the handoff notes so the next agent does not mistake foundation work for launch-ready mobile.",
    summary:
      "The handoff now calls out that the mobile branch is a foundation layer and intentionally avoids server schema or API changes.",
    watching: false,
    messages: [
      {
        author: "docs",
        role: "agent",
        body: "The handoff distinguishes foundation scope from complete launch scope.",
        time: "15:58",
      },
    ],
  },
  {
    id: "team-roster",
    title: "Team roster polish",
    time: "1h",
    owner: "product",
    signal: { tone: "idle", label: "Watching", rank: 4, attention: false },
    preview: "Keep mobile team simple: people and agents only, no configuration controls in Phase 1.",
    summary: "Team remains a lightweight roster. Configuration remains desktop-first for this phase.",
    watching: true,
    messages: [
      {
        author: "product",
        role: "human",
        body: "Mobile is for daily work, not desktop admin squeezed into a phone.",
        time: "15:20",
      },
    ],
  },
];

const MOCK_TEAM: MockPerson[] = [
  { id: "gandy2025", name: "Gandy2025", role: "Owner", status: "Active now", tone: "working" },
  { id: "gandy-coder", name: "gandy-coder", role: "Personal agent", status: "Working", tone: "working" },
  { id: "design-review", name: "design-review", role: "Reviewer agent", status: "Idle", tone: "idle" },
  { id: "docs", name: "docs", role: "Documentation agent", status: "Offline", tone: "offline" },
];

const CHAT_FILTERS = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs you" },
  { value: "watching", label: "Watching" },
] as const;

export function MobilePreviewPage() {
  const [tab, setTab] = useState<PreviewTab>("now");
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [answeringChatId, setAnsweringChatId] = useState<string | null>(null);
  const selectedChat = selectedChatId ? MOCK_CHATS.find((chat) => chat.id === selectedChatId) : null;
  const attentionCount = MOCK_CHATS.filter((chat) => chat.signal.attention).length;
  const unreadCount = MOCK_CHATS.filter((chat) => chat.signal.tone === "unread").length;
  const title = selectedChat ? selectedChat.title : previewTabTitle(tab);

  const chatRows = useMemo(() => {
    if (filter === "attention") return MOCK_CHATS.filter((chat) => chat.signal.attention);
    if (filter === "watching") return MOCK_CHATS.filter((chat) => chat.watching);
    return MOCK_CHATS;
  }, [filter]);

  const openTab = (next: PreviewTab) => {
    setSelectedChatId(null);
    setAnsweringChatId(null);
    setTab(next);
  };

  if (selectedChat) {
    return (
      <PreviewFrame
        title={title}
        left={
          <button
            type="button"
            aria-label="Back to mobile chat"
            onClick={() => setSelectedChatId(null)}
            className="inline-flex items-center justify-center"
            style={iconButtonStyle}
          >
            <ArrowLeft aria-hidden className="h-4 w-4" />
          </button>
        }
        bottom={null}
      >
        <ChatDetail chat={selectedChat} />
      </PreviewFrame>
    );
  }

  const answeringChat = answeringChatId ? MOCK_CHATS.find((chat) => chat.id === answeringChatId) : null;

  return (
    <>
      <PreviewFrame
        title={title}
        right={
          tab === "now" ? (
            <Button type="button" variant="cta" size="sm" onClick={() => openTab("chat")}>
              <Plus className="h-3.5 w-3.5" />
              New
            </Button>
          ) : null
        }
        bottom={
          <PreviewTabs active={tab} attentionCount={attentionCount} unreadCount={unreadCount} onChange={openTab} />
        }
      >
        {tab === "now" ? <NowPreview onOpenChat={setSelectedChatId} onOpenAnswer={setAnsweringChatId} /> : null}
        {tab === "chat" ? (
          <ChatPreview filter={filter} onFilter={setFilter} rows={chatRows} onOpenChat={setSelectedChatId} />
        ) : null}
        {tab === "team" ? <TeamPreview /> : null}
        {tab === "me" ? <MePreview /> : null}
      </PreviewFrame>
      {answeringChat ? (
        <div className="fixed inset-0" style={{ zIndex: 70 }} data-mobile-ask-sheet>
          <AskTakeover
            body={`## Release decision\n\n${answeringChat.preview}`}
            payload={{
              multiSelect: false,
              options: [
                { label: "Ship now", description: "Start the production rollout." },
                { label: "Hold", description: "Keep the release on staging." },
              ],
            }}
            askerName={answeringChat.owner}
            mobile
            onDismiss={() => setAnsweringChatId(null)}
            onReply={() => setAnsweringChatId(null)}
            onSkip={() => setAnsweringChatId(null)}
          />
        </div>
      ) : null}
    </>
  );
}

function PreviewFrame({
  title,
  left,
  right,
  bottom,
  children,
}: {
  title: string;
  left?: ReactNode;
  right?: ReactNode;
  bottom?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="mx-auto flex min-h-screen flex-col overflow-hidden"
      style={{
        height: "100dvh",
        maxWidth: "var(--sp-95)",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      <header
        className="shrink-0 grid items-center"
        style={{
          gridTemplateColumns: "var(--sp-12) minmax(0, 1fr) var(--sp-12)",
          minHeight: "var(--sp-12)",
          padding: "env(safe-area-inset-top) var(--sp-3) 0",
          borderBottom: "var(--hairline) solid var(--border)",
          background: "var(--bg-raised)",
        }}
      >
        <div className="flex items-center justify-start" style={{ minWidth: 0 }}>
          {left ?? <PreviewMark />}
        </div>
        <div className="text-center">
          <div className="text-mobile-title truncate" style={{ color: "var(--fg)" }}>
            {title}
          </div>
        </div>
        <div className="flex items-center justify-end">{right}</div>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      {bottom}
    </div>
  );
}

function PreviewMark() {
  return (
    <div
      className="mono flex items-center justify-center text-mobile-caption"
      style={{
        width: "var(--sp-8)",
        height: "var(--sp-8)",
        borderRadius: "var(--radius-full)",
        background: "var(--bg-active)",
        color: "var(--fg)",
        border: "var(--hairline) solid var(--border)",
      }}
    >
      FT
    </div>
  );
}

function NowPreview({
  onOpenChat,
  onOpenAnswer,
}: {
  onOpenChat: (chatId: string) => void;
  onOpenAnswer: (chatId: string) => void;
}) {
  return (
    <MobilePage className="flex flex-col" padded>
      <div className="flex items-start" style={{ gap: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
        <div className="min-w-0" style={{ flex: 1 }}>
          <h1 className="text-mobile-title" style={{ color: "var(--fg)", margin: 0 }}>
            Now
          </h1>
        </div>
        <span
          className="mono text-mobile-caption"
          style={{
            padding: "var(--sp-0_5) var(--sp-1_5)",
            borderRadius: "var(--radius-chip)",
            background: "var(--state-working-soft)",
            color: "var(--state-working)",
          }}
        >
          Mock data
        </span>
      </div>

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }} data-mobile-feed>
        {MOCK_CHATS.map((chat) => (
          <MockChatRow
            key={chat.id}
            chat={chat}
            onOpen={onOpenChat}
            onAnswer={onOpenAnswer}
            showPrimaryAction={chat.signal.attention}
          />
        ))}
      </div>
    </MobilePage>
  );
}

function ChatPreview({
  filter,
  onFilter,
  rows,
  onOpenChat,
}: {
  filter: ChatFilter;
  onFilter: (next: ChatFilter) => void;
  rows: MockChat[];
  onOpenChat: (chatId: string) => void;
}) {
  return (
    <MobilePage className="flex flex-col" padded>
      <div className="flex items-center" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-3)" }}>
        <div className="relative min-w-0" style={{ flex: 1 }}>
          <Search
            aria-hidden
            className="pointer-events-none absolute h-3.5 w-3.5"
            style={{ left: "var(--sp-2_5)", top: "50%", transform: "translateY(-50%)", color: "var(--fg-4)" }}
          />
          <div
            className="text-mobile-body"
            style={{
              minHeight: "var(--sp-8)",
              padding: "var(--sp-2) var(--sp-3) var(--sp-2) var(--sp-7)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              background: "var(--bg-raised)",
              color: "var(--fg-4)",
            }}
          >
            Search chats
          </div>
        </div>
      </div>
      <div style={{ marginBottom: "var(--sp-3)" }}>
        <MobileSegmentedControl options={CHAT_FILTERS} value={filter} onChange={onFilter} />
      </div>
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        {rows.map((chat) => (
          <MockChatRow key={chat.id} chat={chat} onOpen={onOpenChat} tier="list" />
        ))}
      </div>
    </MobilePage>
  );
}

function TeamPreview() {
  return (
    <MobilePage className="flex flex-col" padded>
      <div style={{ marginBottom: "var(--sp-4)" }}>
        <p className="text-mobile-caption uppercase" style={{ color: "var(--fg-4)", margin: 0 }}>
          Team
        </p>
        <h1 className="text-mobile-title" style={{ color: "var(--fg)", margin: "var(--sp-0_5) 0 0" }}>
          4 teammates
        </h1>
      </div>
      <MobileSection title="People and agents">
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          {MOCK_TEAM.map((person) => (
            <div key={person.id} style={panelStyle} data-mobile-card="panel">
              <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
                <AvatarBubble label={person.name} />
                <div className="min-w-0" style={{ flex: 1 }}>
                  <p className="text-mobile-subtitle truncate" style={{ margin: 0, color: "var(--fg)" }}>
                    {person.name}
                  </p>
                  <p
                    className="text-mobile-body truncate"
                    style={{ margin: "var(--sp-0_5) 0 0", color: "var(--fg-3)" }}
                  >
                    {person.role}
                  </p>
                </div>
                <StatusPill tone={person.tone} label={person.status} />
              </div>
            </div>
          ))}
        </div>
      </MobileSection>
    </MobilePage>
  );
}

function MePreview() {
  return (
    <MobilePage className="flex flex-col" padded>
      <div style={{ ...panelStyle, marginBottom: "var(--sp-5)" }} data-mobile-card="panel">
        <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
          <AvatarBubble label="Gandy2025" large />
          <div className="min-w-0" style={{ flex: 1 }}>
            <h1 className="text-mobile-title truncate" style={{ margin: 0, color: "var(--fg)" }}>
              Gandy2025
            </h1>
            <p className="text-mobile-body" style={{ margin: "var(--sp-0_5) 0 0", color: "var(--fg-3)" }}>
              Preview Team owner
            </p>
          </div>
        </div>
      </div>
      <MobileSection title="Account">
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <MeRow icon={Palette} label="Theme" value="System" />
          <MeRow icon={MonitorCog} label="Desktop settings" value="Open on desktop" />
          <MeRow icon={CircleUserRound} label="Session" value="No login required" />
        </div>
      </MobileSection>
    </MobilePage>
  );
}

function ChatDetail({ chat }: { chat: MockChat }) {
  return (
    <MobilePage className="flex flex-col" padded>
      <div style={{ marginBottom: "var(--sp-4)" }}>
        <MobileSignalChip signal={chat.signal} />
        <h1 className="text-mobile-title" style={{ margin: "var(--sp-2) 0 var(--sp-1)", color: "var(--fg)" }}>
          {chat.title}
        </h1>
        <p className="text-mobile-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          {chat.owner} updated {chat.time} ago
        </p>
      </div>

      <MobileSection title="Summary">
        <div style={panelStyle} data-mobile-card="panel">
          <p className="text-mobile-body" style={{ margin: 0, color: "var(--fg-2)" }}>
            {chat.summary}
          </p>
        </div>
      </MobileSection>

      <div className="flex flex-col" style={{ gap: "var(--sp-3)", marginTop: "var(--sp-5)" }}>
        {chat.messages.map((message) => (
          <div key={`${message.author}-${message.time}`} className={message.role === "human" ? "self-end" : ""}>
            <div
              style={{
                ...panelStyle,
                maxWidth: "var(--sp-75)",
                background: message.role === "human" ? "var(--bg-active)" : "var(--bg-raised)",
              }}
            >
              <p className="text-mobile-caption" style={{ margin: 0, color: "var(--fg-4)" }}>
                {message.author} - {message.time}
              </p>
              <p className="text-mobile-body" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-2)" }}>
                {message.body}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div
        className="text-mobile-body"
        style={{
          marginTop: "auto",
          paddingTop: "var(--sp-5)",
          color: "var(--fg-4)",
        }}
      >
        Composer is intentionally disabled in this mock preview.
      </div>
    </MobilePage>
  );
}

function MockChatRow({
  chat,
  onOpen,
  onAnswer,
  compact = false,
  tier,
  showPrimaryAction = false,
}: {
  chat: MockChat;
  onOpen: (chatId: string) => void;
  onAnswer?: (chatId: string) => void;
  compact?: boolean;
  tier?: "feed" | "list";
  showPrimaryAction?: boolean;
}) {
  const cardTier = tier ?? (compact ? "list" : "feed");
  const actionLabel = showPrimaryAction ? primaryActionLabel(chat.signal.tone) : null;
  const accent = cardTier === "feed" ? mobileAccentColor(chat.signal.tone) : null;
  const cardStyle = {
    ...mobileCardStyle(actionLabel ? "priorityFeed" : cardTier),
    ...(accent ? { boxShadow: `inset var(--hairline-bold) 0 0 0 ${accent}` } : {}),
    position: "relative" as const,
  };
  const actions: MobileChatAction[] = [
    { key: "pin", label: "Pin chat", shortLabel: "Pin", icon: Pin, disabled: false, onSelect: () => undefined },
    {
      key: "mark-unread",
      label: "Mark as unread",
      shortLabel: "Unread",
      icon: Mail,
      disabled: false,
      onSelect: () => undefined,
    },
    {
      key: "archive",
      label: "Archive chat",
      shortLabel: "Archive",
      icon: Archive,
      disabled: false,
      onSelect: () => undefined,
    },
  ];
  const content = (
    <div className="relative flex h-full flex-col" style={{ gap: "var(--sp-3)", zIndex: 1, pointerEvents: "none" }}>
      <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
        <AvatarBubble label={chat.title} />
        <div className="min-w-0" style={{ flex: 1 }}>
          <MobileSignalChip signal={chat.signal} />
        </div>
        <span className="mono text-mobile-caption shrink-0" style={{ color: "var(--fg-4)" }}>
          {chat.time}
        </span>
        <span style={{ pointerEvents: "auto" }}>
          <MobileCardActionsMenu actions={actions} title={chat.title} />
        </span>
      </div>
      <p
        className={cardTier === "feed" ? "text-mobile-title" : "text-mobile-subtitle"}
        style={{
          color: "var(--fg)",
          margin: 0,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
        data-mobile-card-title
      >
        {chat.title}
      </p>
      {!compact ? (
        <p
          className="text-mobile-body"
          style={{
            color: "var(--fg-3)",
            margin: 0,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
          data-mobile-card-preview
        >
          {chat.preview}
        </p>
      ) : null}
      {actionLabel ? (
        <div className="flex items-center" style={{ marginTop: "auto", pointerEvents: "auto" }}>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => {
              if (chat.signal.tone === "needs-you" && onAnswer) onAnswer(chat.id);
              else onOpen(chat.id);
            }}
            data-mobile-primary-action
          >
            {actionLabel}
            <ArrowRight aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <MobileSwipeCard actions={actions}>
      <article style={cardStyle} data-mobile-card={cardTier}>
        <button
          type="button"
          aria-label={`Open ${chat.title}`}
          onClick={() => onOpen(chat.id)}
          className="absolute inset-0 cursor-pointer border-0 bg-transparent"
          style={{ zIndex: 0 }}
        />
        {content}
      </article>
    </MobileSwipeCard>
  );
}

function previewTabTitle(tab: PreviewTab): string {
  switch (tab) {
    case "now":
      return "Now";
    case "chat":
      return "Chat";
    case "team":
      return "Team";
    case "me":
      return "Me";
  }
}

function primaryActionLabel(tone: MobileChatSignal["tone"]): string | null {
  switch (tone) {
    case "needs-you":
      return "Answer";
    case "error":
      return "Review";
    case "unread":
    case "working":
    case "idle":
      return null;
  }
}

function PreviewTabs({
  active,
  attentionCount,
  unreadCount,
  onChange,
}: {
  active: PreviewTab;
  attentionCount: number;
  unreadCount: number;
  onChange: (tab: PreviewTab) => void;
}) {
  const tabs: Array<{ tab: PreviewTab; label: string; icon: LucideIcon; badge: number }> = [
    { tab: "now", label: "Now", icon: Activity, badge: attentionCount },
    { tab: "chat", label: "Chat", icon: MessageSquareText, badge: unreadCount },
    { tab: "team", label: "Team", icon: UsersRound, badge: 0 },
    { tab: "me", label: "Me", icon: CircleUserRound, badge: 0 },
  ];

  return (
    <nav
      aria-label="Mobile preview"
      className="shrink-0 grid"
      style={{
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        minHeight: "calc(var(--mobile-tabbar-height) + env(safe-area-inset-bottom))",
        padding: "var(--sp-1) var(--sp-2) env(safe-area-inset-bottom)",
        borderTop: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.tab === active;
        const Icon = tab.icon;
        return (
          <button
            key={tab.tab}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => onChange(tab.tab)}
            className={cn(
              "relative flex min-h-[var(--sp-11)] flex-col items-center justify-center",
              !isActive && "opacity-70",
            )}
            style={{
              gap: "var(--sp-0_5)",
              color: isActive ? "var(--fg)" : "var(--fg-3)",
              border: 0,
              background: "transparent",
              cursor: isActive ? "default" : "pointer",
            }}
          >
            <Icon aria-hidden size={18} strokeWidth={isActive ? 2.2 : 1.8} />
            <span className="text-mobile-label">{tab.label}</span>
            {tab.badge > 0 ? <TabBadge count={tab.badge} /> : null}
          </button>
        );
      })}
    </nav>
  );
}

function TabBadge({ count }: { count: number }) {
  return (
    <span
      className="mono absolute text-mobile-caption"
      style={{
        top: "var(--sp-1)",
        right: "calc(50% - var(--sp-6))",
        minWidth: "var(--sp-3_5)",
        height: "var(--sp-3_5)",
        padding: "0 var(--sp-1)",
        borderRadius: "var(--radius-full)",
        background: "var(--state-needs-you)",
        color: "var(--fg-on-vivid)",
        lineHeight: "var(--sp-3_5)",
        textAlign: "center",
      }}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

function AvatarBubble({ label, large = false }: { label: string; large?: boolean }) {
  const letters = label
    .split(/[\s-]+/)
    .map((part) => part.at(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div
      className="mono flex shrink-0 items-center justify-center text-mobile-caption"
      style={{
        width: large ? "var(--sp-12)" : "var(--sp-8)",
        height: large ? "var(--sp-12)" : "var(--sp-8)",
        borderRadius: "var(--radius-full)",
        background: "var(--bg-active)",
        color: "var(--fg)",
        border: "var(--hairline) solid var(--border)",
      }}
    >
      {letters || "FT"}
    </div>
  );
}

function StatusPill({ tone, label }: { tone: MockPerson["tone"]; label: string }) {
  const color =
    tone === "working" ? "var(--state-working)" : tone === "idle" ? "var(--state-idle)" : "var(--state-offline)";
  return (
    <span className="mono text-mobile-caption shrink-0" style={{ color, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

function MeRow({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div style={panelStyle} data-mobile-card="panel">
      <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
        <Icon aria-hidden className="h-4 w-4 shrink-0" style={{ color: "var(--fg-3)" }} />
        <div className="min-w-0" style={{ flex: 1 }}>
          <p className="text-mobile-subtitle truncate" style={{ margin: 0, color: "var(--fg)" }}>
            {label}
          </p>
          <p className="text-mobile-body truncate" style={{ margin: "var(--sp-0_5) 0 0", color: "var(--fg-3)" }}>
            {value}
          </p>
        </div>
      </div>
    </div>
  );
}

const panelStyle = mobileCardStyle("panel");

const iconButtonStyle = {
  width: "var(--sp-8)",
  height: "var(--sp-8)",
  border: "var(--hairline) solid var(--border)",
  borderRadius: "var(--radius-full)",
  background: "var(--bg-raised)",
  color: "var(--fg)",
  cursor: "pointer",
} as const;
