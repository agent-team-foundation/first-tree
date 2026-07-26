import { ArrowLeft, ArrowRight, CircleUserRound, Filter, ListTodo, Pin, Plus, Search, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { AskTakeover } from "../components/chat/ask-takeover.js";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import { MobilePage, mobileCardStyle } from "./mobile/components.js";
import { MobileCurrentStateCard } from "./mobile/current-state-card.js";

type PreviewTab = "work" | "team" | "me";

type PreviewChat = {
  id: string;
  title: string;
  summary: string;
  evidence: string;
  time: string;
  state: "request" | "failed" | "pinned" | "working" | "recent";
};

const CHATS: PreviewChat[] = [
  {
    id: "release",
    title: "Release readiness",
    summary:
      "Staging is green, the migration rehearsal completed, and support has the runbook. Production rollout still needs a final approval after the launch owner checks the remaining mobile evidence.",
    evidence: "Please review the launch checklist and choose the rollout window.",
    time: "2m",
    state: "request",
  },
  {
    id: "deploy",
    title: "Mobile deploy failure",
    summary: "The latest mobile deployment stopped during the asset upload.",
    evidence: "Upload failed after three retries; logs and recovery steps are ready.",
    time: "8m",
    state: "failed",
  },
  {
    id: "context",
    title: "Context docs",
    summary: "The handoff now separates foundation scope from launch readiness.",
    evidence: "Summary updated",
    time: "18m",
    state: "pinned",
  },
  {
    id: "qa",
    title: "Visual QA",
    summary: "Small-phone layouts are being checked before the release can move.",
    evidence: "Working · Testing small, standard, and large phone widths",
    time: "34m",
    state: "working",
  },
  {
    id: "roster",
    title: "Team roster polish",
    summary: "Mobile Team stays focused on people and agents; admin remains desktop-first.",
    evidence: "",
    time: "1h",
    state: "recent",
  },
];

export function MobilePreviewPage() {
  const [tab, setTab] = useState<PreviewTab>("work");
  const [selected, setSelected] = useState<PreviewChat | null>(null);
  const [answering, setAnswering] = useState(false);

  if (selected) {
    return (
      <PreviewShell bottom={null}>
        <ChatDetail chat={selected} onBack={() => setSelected(null)} />
      </PreviewShell>
    );
  }

  return (
    <>
      <PreviewShell bottom={<PreviewTabs active={tab} onChange={setTab} />}>
        {tab === "work" ? <WorkPreview onOpen={setSelected} onAnswer={() => setAnswering(true)} /> : null}
        {tab === "team" ? <TeamPreview /> : null}
        {tab === "me" ? <MePreview /> : null}
      </PreviewShell>
      {answering ? (
        <div className="fixed inset-0" style={{ zIndex: 70 }} data-mobile-ask-sheet>
          <AskTakeover
            body={"## Release decision\n\nPlease review the launch checklist and choose the rollout window."}
            payload={{
              multiSelect: false,
              options: [
                { label: "Ship now", description: "Start the production rollout." },
                { label: "Hold", description: "Keep the release on staging." },
              ],
            }}
            askerName="gandy-coder"
            mobile
            onDismiss={() => setAnswering(false)}
            onReply={() => setAnswering(false)}
            onSkip={() => setAnswering(false)}
          />
        </div>
      ) : null}
    </>
  );
}

function PreviewShell({ children, bottom }: { children: ReactNode; bottom: ReactNode }) {
  return (
    <div
      className="h-dvh-screen mx-auto flex flex-col overflow-hidden pt-safe-top"
      style={{ maxWidth: 430, background: "var(--bg)", color: "var(--fg)" }}
    >
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      {bottom}
    </div>
  );
}

function WorkPreview({ onOpen, onAnswer }: { onOpen: (chat: PreviewChat) => void; onAnswer: () => void }) {
  const needsYou = CHATS.filter((chat) => chat.state === "request" || chat.state === "failed");
  const pinned = CHATS.filter((chat) => chat.state === "pinned");
  const recent = CHATS.filter((chat) => chat.state === "working" || chat.state === "recent");

  return (
    <MobilePage className="flex flex-col" padded>
      <div className="flex items-center" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-3)" }}>
        <h1 className="text-mobile-title min-w-0 flex-1" style={{ color: "var(--fg)", margin: 0 }}>
          Work
        </h1>
        <IconButton label="Search Work">
          <Search aria-hidden className="h-5 w-5" />
        </IconButton>
        <IconButton label="Start new work" raised>
          <Plus aria-hidden className="h-5 w-5" />
        </IconButton>
      </div>

      <div
        className="flex shrink-0 items-center"
        style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-5)" }}
        data-mobile-work-quick-views
      >
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto" style={{ gap: "var(--sp-2)" }}>
          <QuickChip label="Need you" count={2} />
          <QuickChip label="Unread" count={3} />
          <QuickChip label="Pinned" count={1} />
        </div>
        <IconButton label="Filter Work" compact>
          <Filter aria-hidden className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }} data-mobile-work-list>
        {needsYou.map((chat) => (
          <ActionCard key={chat.id} chat={chat} onOpen={onOpen} onAnswer={onAnswer} />
        ))}
        {pinned.map((chat) => (
          <WorkRow key={chat.id} chat={chat} onOpen={onOpen} />
        ))}
        {recent.map((chat) => (
          <WorkRow key={chat.id} chat={chat} onOpen={onOpen} />
        ))}
      </div>
    </MobilePage>
  );
}

function ActionCard({
  chat,
  onOpen,
  onAnswer,
}: {
  chat: PreviewChat;
  onOpen: (chat: PreviewChat) => void;
  onAnswer: () => void;
}) {
  const request = chat.state === "request";
  return (
    <article style={{ ...mobileCardStyle("priorityFeed"), position: "relative" }} data-mobile-card="action">
      <button
        type="button"
        aria-label={`Open ${chat.title}`}
        onClick={() => onOpen(chat)}
        className="absolute inset-0 border-0 bg-transparent"
      />
      <div className="relative flex h-full flex-col" style={{ gap: "var(--sp-2)", pointerEvents: "none" }}>
        <div className="flex items-center">
          <span
            className="text-mobile-subtitle min-w-0 flex-1"
            style={{ color: request ? "var(--fg-needs-you-strong)" : "var(--state-error)" }}
          >
            {request ? "Needs your answer" : "Run failed"}
          </span>
          <span className="mono text-mobile-caption" style={{ color: "var(--fg-4)" }}>
            {chat.time}
          </span>
        </div>
        <h3 className="text-mobile-title" style={{ color: "var(--fg)", margin: 0 }}>
          {chat.title}
        </h3>
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
          data-line-clamp={2}
        >
          {chat.evidence}
        </p>
        <div className="flex justify-end" style={{ marginTop: "auto", pointerEvents: "auto" }}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11"
            onClick={() => (request ? onAnswer() : onOpen(chat))}
            data-mobile-primary-action
          >
            {request ? "Answer" : "Review"}
            <ArrowRight aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </article>
  );
}

function WorkRow({ chat, onOpen }: { chat: PreviewChat; onOpen: (chat: PreviewChat) => void }) {
  const dynamic = chat.state === "working";
  return (
    <button
      type="button"
      aria-label={`Open ${chat.title}`}
      onClick={() => onOpen(chat)}
      className="w-full text-left"
      style={{ ...mobileCardStyle("list"), minHeight: "calc(var(--sp-20) + var(--sp-8))" }}
      data-mobile-card="work"
    >
      <div className="flex" style={{ gap: "var(--sp-3)" }}>
        <Avatar label={chat.title} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            <span className="text-mobile-subtitle truncate flex-1">{chat.title}</span>
            <span className="mono text-mobile-caption" style={{ color: "var(--fg-4)" }}>
              {chat.time}
            </span>
            {chat.state === "pinned" ? <Pin aria-label="Pinned" className="h-4 w-4" /> : null}
          </div>
          <p
            className={cn("text-mobile-body", dynamic && "truncate")}
            style={{
              color: "var(--fg-3)",
              margin: "var(--sp-2) 0 0",
              ...(dynamic
                ? undefined
                : {
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }),
            }}
            data-line-clamp={dynamic ? 1 : 3}
          >
            {chat.summary}
          </p>
          {dynamic ? (
            <p
              className="text-mobile-caption truncate"
              style={{ color: "var(--fg-success-strong)", margin: "var(--sp-1) 0 0" }}
            >
              {chat.evidence}
            </p>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function ChatDetail({ chat, onBack }: { chat: PreviewChat; onBack: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        className="shrink-0 flex items-center"
        style={{
          minHeight: "var(--sp-12)",
          gap: "var(--sp-2)",
          padding: "0 var(--sp-2)",
          borderBottom: "var(--hairline) solid var(--border)",
          background: "var(--bg-raised)",
        }}
      >
        <IconButton label="Back to Work" onClick={onBack}>
          <ArrowLeft aria-hidden className="h-5 w-5" />
        </IconButton>
        <h1 className="text-mobile-subtitle truncate" style={{ margin: 0 }}>
          {chat.title}
        </h1>
      </header>
      <MobilePage className="flex flex-col" padded>
        <MobileCurrentStateCard
          description={`${chat.summary}\n\n**Next:** ${chat.evidence}`}
          descriptionUpdatedAt="2026-07-23T17:00:00.000Z"
          lastReadAt="2026-07-23T16:00:00.000Z"
        />
        <Message author="gandy-coder" body="The latest evidence is attached and the remaining decision is explicit." />
        <Message author="Gandy" body="I’ll review the current state and choose the next step." self />
        <div
          className="text-mobile-body"
          style={{
            marginTop: "auto",
            padding: "var(--sp-3)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--fg-4)",
          }}
        >
          Reply…
        </div>
      </MobilePage>
    </div>
  );
}

function Message({ author, body, self = false }: { author: string; body: string; self?: boolean }) {
  return (
    <div className={cn("flex", self && "justify-end")} style={{ marginBottom: "var(--sp-3)" }}>
      <div
        style={{
          ...mobileCardStyle("panel"),
          maxWidth: "85%",
          background: self ? "var(--bg-active)" : "var(--bg-raised)",
        }}
      >
        <p className="text-mobile-caption" style={{ color: "var(--fg-4)", margin: 0 }}>
          {author}
        </p>
        <p className="text-mobile-body" style={{ color: "var(--fg-2)", margin: "var(--sp-1) 0 0" }}>
          {body}
        </p>
      </div>
    </div>
  );
}

function TeamPreview() {
  return (
    <MobilePage padded>
      <h1 className="text-mobile-title" style={{ margin: "0 0 var(--sp-4)" }}>
        Team
      </h1>
      {["Gandy", "gandy-coder", "design-review"].map((name) => (
        <div key={name} className="flex items-center" style={{ ...mobileCardStyle("list"), gap: "var(--sp-3)" }}>
          <Avatar label={name} />
          <span className="text-mobile-subtitle">{name}</span>
        </div>
      ))}
    </MobilePage>
  );
}

function MePreview() {
  return (
    <MobilePage padded>
      <h1 className="text-mobile-title" style={{ margin: "0 0 var(--sp-4)" }}>
        Me
      </h1>
      <div className="flex items-center" style={{ ...mobileCardStyle("panel"), gap: "var(--sp-3)" }}>
        <Avatar label="Gandy" />
        <div>
          <p className="text-mobile-subtitle" style={{ margin: 0 }}>
            Gandy
          </p>
          <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: "var(--sp-1) 0 0" }}>
            Team owner
          </p>
        </div>
      </div>
    </MobilePage>
  );
}

function PreviewTabs({ active, onChange }: { active: PreviewTab; onChange: (tab: PreviewTab) => void }) {
  const tabs = [
    { id: "work" as const, label: "Work", icon: ListTodo },
    { id: "team" as const, label: "Team", icon: UsersRound },
    { id: "me" as const, label: "Me", icon: CircleUserRound },
  ];
  return (
    <nav
      aria-label="Mobile preview"
      className="shrink-0 grid"
      style={{
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        minHeight: "calc(var(--mobile-tabbar-height) + env(safe-area-inset-bottom))",
        padding: "var(--sp-1) var(--sp-2) env(safe-area-inset-bottom)",
        borderTop: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-current={active === id ? "page" : undefined}
          onClick={() => onChange(id)}
          className={cn(
            "flex min-h-[var(--sp-11)] flex-col items-center justify-center",
            active !== id && "opacity-70",
          )}
          style={{
            gap: "var(--sp-0_5)",
            color: active === id ? "var(--fg)" : "var(--fg-3)",
            border: 0,
            background: "transparent",
          }}
        >
          <Icon aria-hidden size={18} />
          <span className="text-mobile-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}

function QuickChip({ label, count }: { label: string; count: number }) {
  return (
    <button
      type="button"
      className="text-mobile-body inline-flex h-11 shrink-0 items-center rounded-[var(--radius-input)]"
      style={{
        gap: "var(--sp-2)",
        padding: "0 var(--sp-3)",
        border: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      {label}
      <span className="mono text-mobile-caption" style={{ color: "var(--fg-3)" }}>
        {count}
      </span>
    </button>
  );
}

function IconButton({
  label,
  children,
  raised = false,
  compact = false,
  onClick,
}: {
  label: string;
  children: ReactNode;
  raised?: boolean;
  compact?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex shrink-0 items-center justify-center rounded-[var(--radius-full)]"
      style={{
        width: 44,
        height: 44,
        border: compact ? "var(--hairline) solid var(--border)" : 0,
        background: raised ? "var(--bg-active)" : compact ? "var(--bg-raised)" : "transparent",
        color: "var(--fg)",
      }}
    >
      {children}
    </button>
  );
}

function Avatar({ label }: { label: string }) {
  return (
    <span
      className="text-mobile-caption inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-full)]"
      style={{ background: "var(--bg-active)", color: "var(--fg)" }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
