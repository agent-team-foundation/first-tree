import type { GithubEventCard, MeChatRow } from "@first-tree/shared";
import {
  ArrowRight,
  ChevronDown,
  CircleDot,
  ExternalLink,
  Filter,
  Github,
  GitMerge,
  GitPullRequest,
  ListTree,
  type LucideIcon,
  PanelRight,
  Paperclip,
  Plus,
  Search,
  Send,
  UserPlus,
  Users,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { Avatar } from "../components/avatar.js";
import { ActivityDots } from "../components/chat/activity-dots.js";
import { ChatRowAvatar } from "../components/chat/chat-row-avatar.js";
import { GithubEventCardMessage, GithubSystemAvatar } from "../components/chat/github-event-card.js";
import {
  ONBOARDING_ORIENTATION_CHAPTERS,
  ONBOARDING_ORIENTATION_DEFAULT_CHAPTER_ID,
  type OnboardingOrientationChapterId,
} from "../components/chat/onboarding-orientation.js";
import { FirstTreeLogo } from "../components/first-tree-logo.js";
import { Button } from "../components/ui/button.js";
import { DenseBadge } from "../components/ui/dense-badge.js";
import { StatusGlyph } from "../components/ui/status-glyph.js";
import { ContextTreeLoopScene } from "./onboarding-orientation-context-loop-scene.js";

const FPS = 30;

type ChapterId = OnboardingOrientationChapterId;

type OrientationVideoController = {
  fps: number;
  frameCount: number;
  setFrame: (frame: number) => void;
};

declare global {
  interface Window {
    orientationVideoController?: OrientationVideoController;
  }
}

function isChapterId(value: string | null): value is ChapterId {
  return value !== null && Object.getOwnPropertyDescriptor(ONBOARDING_ORIENTATION_CHAPTERS, value) !== undefined;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function progress(time: number, start: number, end: number): number {
  return clamp((time - start) / (end - start));
}

function ease(value: number): number {
  return 1 - (1 - value) ** 3;
}

function smoothstep(value: number): number {
  const amount = clamp(value);
  return amount * amount * (3 - 2 * amount);
}

function enterStyle(value: number, offset = 0.8): CSSProperties {
  const amount = ease(clamp(value));
  return {
    opacity: amount,
    transform: `translateY(${(1 - amount) * offset}rem)`,
  };
}

/** DEV-only, deterministic recording surface. It never reads auth or server data. */
export function OnboardingOrientationVideoPreviewPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestedChapter = params.get("chapter");
  const chapterId = isChapterId(requestedChapter) ? requestedChapter : ONBOARDING_ORIENTATION_DEFAULT_CHAPTER_ID;
  const initialFrame = Number.parseInt(params.get("frame") ?? "0", 10);
  const [frame, setFrame] = useState(Number.isFinite(initialFrame) ? Math.max(0, initialFrame) : 0);
  const chapter = ONBOARDING_ORIENTATION_CHAPTERS[chapterId];
  const frameCount = chapter.durationInSeconds * FPS;
  const time = Math.min(frame / FPS, chapter.durationInSeconds);
  const githubConnectionConcept = chapterId === "github" && time < 3;
  const sceneTime = chapterId === "github" ? Math.max(0, time - 3) : time;

  useEffect(() => {
    window.orientationVideoController = {
      fps: FPS,
      frameCount,
      setFrame: (nextFrame) => {
        flushSync(() => setFrame(Math.max(0, Math.min(frameCount - 1, Math.round(nextFrame)))));
      },
    };
    document.documentElement.dataset.orientationVideoReady = "true";
    return () => {
      delete window.orientationVideoController;
      delete document.documentElement.dataset.orientationVideoReady;
    };
  }, [frameCount]);

  return (
    <div
      id="orientation-video-frame"
      data-chapter={chapterId}
      data-frame={frame}
      className="h-screen w-screen overflow-hidden bg-background text-foreground"
    >
      {githubConnectionConcept ? (
        <GithubConnectionConcept time={time} />
      ) : (
        <>
          <ProductHeader activeItem={chapterId === "context-tree" && time >= 55.2 ? "Context" : "Workspace"} />
          {chapterId === "context-tree" ? (
            <ContextTreeLoopScene time={time} />
          ) : (
            <div className="flex h-[calc(100vh-3rem)] min-h-0" data-orientation-video-scene="workspace">
              <ConversationRail chapterId={chapterId} time={sceneTime} />
              <main className="relative flex min-w-0 flex-1 flex-col bg-background">
                <ChatHeader chapterId={chapterId} time={sceneTime} />
                <div className="min-h-0 flex-1 overflow-hidden">
                  {chapterId === "multi-agent" ? <MultiAgentScene time={sceneTime} /> : null}
                  {chapterId === "github" ? <GithubScene time={sceneTime} /> : null}
                </div>
                <Composer />
              </main>
              <RightSidebar chapterId={chapterId} time={sceneTime} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GithubConnectionConcept({ time }: { time: number }) {
  const connectionIn = progress(time, 0.25, 1.1);
  const eventsIn = progress(time, 0.9, 1.7);
  const fadeOut = progress(time, 2.55, 3);
  return (
    <div
      className="flex h-screen flex-col items-center justify-center bg-background px-16"
      data-orientation-video-scene="github-connection"
      style={{ opacity: 1 - ease(fadeOut) }}
    >
      <div className="w-full max-w-5xl">
        <p className="text-eyebrow mb-5 text-center text-fg-4">REPOSITORY CONNECTION</p>
        <div className="grid items-center" style={{ gridTemplateColumns: "1fr 15rem 1fr", gap: "var(--sp-5)" }}>
          <ConnectionEndpoint
            icon={
              <span className="flex size-11 items-center justify-center rounded-full bg-foreground text-background">
                <Github size={24} strokeWidth={1.8} />
              </span>
            }
            title="GitHub App"
            primary="acme/first-tree-web"
            secondary="Repository scoped"
          />
          <div className="flex min-w-0 flex-col items-center" style={{ opacity: ease(connectionIn) }}>
            <div className="flex w-full items-center text-primary" style={{ gap: "var(--sp-2)" }}>
              <span className="h-px min-w-0 flex-1 bg-border-strong" />
              <span className="flex size-9 items-center justify-center rounded-full border border-border bg-bg-raised">
                <ArrowRight size={18} strokeWidth={1.8} />
              </span>
              <span className="h-px min-w-0 flex-1 bg-border-strong" />
            </div>
            <p className="mono mt-3 whitespace-nowrap text-caption text-fg-3" style={enterStyle(eventsIn, 0.3)}>
              Issue · PR · review events
            </p>
          </div>
          <ConnectionEndpoint
            icon={
              <span className="flex size-11 items-center justify-center rounded-[var(--radius-input)] bg-secondary text-foreground">
                <FirstTreeLogo width={22} height={26} />
              </span>
            }
            title="First Tree"
            primary="Acme team"
            secondary="Connected"
          />
        </div>
      </div>
    </div>
  );
}

function ConnectionEndpoint({
  icon,
  title,
  primary,
  secondary,
}: {
  icon: ReactNode;
  title: string;
  primary: string;
  secondary: string;
}) {
  return (
    <section className="flex min-h-40 items-center rounded-[var(--radius-panel)] border border-border bg-bg-raised p-6 shadow-[var(--shadow-sm)]">
      {icon}
      <div className="ml-4 min-w-0">
        <p className="text-headline font-semibold">{title}</p>
        <p className="mono mt-2 truncate text-label text-fg-2">{primary}</p>
        <p className="mt-1 flex items-center text-caption text-fg-3" style={{ gap: "var(--sp-1_5)" }}>
          <span className="size-1.5 rounded-full bg-state-working" />
          {secondary}
        </p>
      </div>
    </section>
  );
}

function ProductHeader({ activeItem }: { activeItem: "Workspace" | "Context" }) {
  const navItems = ["Workspace", "Context", "Team", "Settings"] as const;
  return (
    <header
      className="relative grid h-12 shrink-0 items-center border-b border-border bg-bg-raised px-3"
      style={{ gridTemplateColumns: "1fr auto 1fr", gap: "var(--sp-3)" }}
    >
      <div className="flex min-w-0 items-center" style={{ gap: "var(--sp-3_5)", justifySelf: "start" }}>
        <div className="flex shrink-0 items-center" style={{ gap: 10 }}>
          <FirstTreeLogo width={16} height={18} className="text-foreground" />
          <span className="text-title">First Tree</span>
        </div>
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <button type="button" className="flex min-w-0 items-center text-subtitle" style={{ gap: "var(--sp-1)" }}>
          <span className="truncate">Acme team</span>
          <ChevronDown size={13} className="shrink-0 text-fg-4" />
        </button>
      </div>
      <nav className="flex" style={{ gap: 2, justifySelf: "center" }} aria-label="Product areas">
        {navItems.map((item) => {
          const active = item === activeItem;
          return (
            <span
              key={item}
              className="inline-flex items-center text-subtitle font-medium"
              style={{
                padding: "var(--sp-1_5) var(--sp-3)",
                borderRadius: 5,
                color: active ? "var(--fg)" : "var(--fg-3)",
                background: active ? "var(--bg-hover)" : "transparent",
              }}
            >
              {item}
            </span>
          );
        })}
      </nav>
      <div className="flex shrink-0 items-center" style={{ gap: 6, justifySelf: "end" }}>
        <button
          type="button"
          className="flex h-8 items-center border border-border px-2 text-body text-fg-3"
          style={{ gap: 7, borderRadius: "var(--radius-input)" }}
        >
          <Search size={14} />
          <span>Jump to…</span>
          <span className="mono text-caption text-fg-4">⌘K</span>
        </button>
        <Avatar name="Gandy" seed="human-gandy" size={28} />
      </div>
    </header>
  );
}

function ChatHeader({ chapterId, time }: { chapterId: ChapterId; time: number }) {
  const title = chapterId === "multi-agent" ? "Add chat search" : GITHUB_CHAT_TITLE;
  const participantCount =
    chapterId === "multi-agent" ? 2 + Number(time >= 4.7) + Number(time >= 12.2) + Number(time >= 23.8) : 2;
  return (
    <header className="flex min-h-12 shrink-0 items-center bg-bg-raised px-6 py-1.5">
      <p
        className="min-w-0 flex-1 truncate text-subtitle font-semibold"
        style={chapterId === "github" ? enterStyle(progress(time, 1.8, 2.2), 0.35) : undefined}
      >
        {title}
      </p>
      <div className="flex items-center text-fg-3" style={{ gap: "var(--sp-1)" }}>
        <Users size={15} />
        <span className="mono text-caption">{participantCount}</span>
        <UserPlus size={16} className="ml-2" />
        <PanelRight size={17} className="ml-2 text-foreground" />
      </div>
    </header>
  );
}

type RailRow = { title: string; meta: string; status: "working" | "done" | "idle" };

function railRows(chapterId: ChapterId, time: number): RailRow[] {
  if (chapterId === "multi-agent") return [];
  return [
    {
      title: "Release readiness",
      meta: time >= 24 ? "PR merged" : "Agent task",
      status: time >= 24 ? "done" : "working",
    },
    { title: "First-chat rollout", meta: "Yesterday", status: "idle" },
  ];
}

function ConversationRail({ chapterId, time }: { chapterId: ChapterId; time: number }) {
  const rows = railRows(chapterId, time);
  const githubChatArrived = chapterId === "github" && time >= 0.6;
  const githubChatSelected = chapterId !== "github" || time >= 1.8;
  const groupCount = rows.length + Number(chapterId !== "github" || githubChatArrived);
  const selectedTitle = chapterId === "multi-agent" ? "Add chat search" : GITHUB_CHAT_TITLE;
  const participants: MeChatRow["participants"] = [
    { agentId: "human-gandy", displayName: "Gandy", type: "human", avatarColorToken: null, avatarImageUrl: null },
    { agentId: "nova-lead", displayName: "nova-lead", type: "agent", avatarColorToken: "hue-2", avatarImageUrl: null },
    ...(chapterId === "multi-agent" && time >= 4.7
      ? [
          {
            agentId: "prism-ux",
            displayName: "prism-ux",
            type: "agent",
            avatarColorToken: "hue-5",
            avatarImageUrl: null,
          },
        ]
      : []),
    ...(chapterId === "multi-agent" && time >= 12.2
      ? [
          {
            agentId: "forge-dev",
            displayName: "forge-dev",
            type: "agent",
            avatarColorToken: "hue-6",
            avatarImageUrl: null,
          },
        ]
      : []),
    ...(chapterId === "multi-agent" && time >= 23.8
      ? [
          {
            agentId: "sentinel-qa",
            displayName: "sentinel-qa",
            type: "agent",
            avatarColorToken: "hue-1",
            avatarImageUrl: null,
          },
        ]
      : []),
  ];
  return (
    <aside className="flex w-70 shrink-0 flex-col overflow-hidden border-r border-border bg-bg-raised">
      <div className="shrink-0 flex flex-col border-b border-border-faint">
        <div className="flex items-center px-3 py-2.5" style={{ gap: "var(--sp-1)" }}>
          <Button type="button" variant="cta" size="xs" className="text-body">
            <Plus size={14} strokeWidth={2} />
            <span>New chat</span>
          </Button>
          <span className="ml-auto" />
          <button type="button" aria-label="Filter" className="inline-flex items-center px-1.5 py-0.5 text-fg-3">
            <Filter size={14} strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex items-center px-3 pb-2.5">
          <div className="flex items-center" style={{ gap: 2 }}>
            <span className="rounded bg-bg-active px-1.5 py-0.5 text-label text-foreground">All</span>
            <span className="px-1.5 py-0.5 text-label text-fg-3">Unread</span>
            <span className="px-1.5 py-0.5 text-label text-fg-3">Watching</span>
          </div>
          <span className="ml-auto flex items-center text-label text-fg-2" style={{ gap: 4 }}>
            <ListTree size={13} strokeWidth={1.75} className="text-fg-4" />
            {chapterId === "github" ? "Source" : "Recent"} <ChevronDown size={12} />
          </span>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="flex items-center px-3 pb-0.5 pt-1.5 text-eyebrow uppercase text-fg-4" style={{ gap: 4 }}>
          <ChevronDown size={10} /> {chapterId === "github" ? "From GitHub" : "Today"}{" "}
          <span className="mono font-normal">{groupCount}</span>
        </div>
        {chapterId !== "github" || githubChatArrived ? (
          <div style={chapterId === "github" ? enterStyle(progress(time, 0.6, 1.4), 0.35) : undefined}>
            <RealRailItem
              title={selectedTitle}
              participants={participants}
              selected={githubChatSelected}
              working={
                chapterId === "github" ? (time >= 4.2 && time < 10.8) || (time >= 15.8 && time < 20.2) : time < 31
              }
              timeLabel={chapterId === "github" ? "now" : undefined}
              unreadCount={chapterId === "github" && !githubChatSelected ? 1 : 0}
            />
          </div>
        ) : null}
        {rows.map((row, index) => (
          <div
            key={row.title}
            style={
              chapterId === "github"
                ? undefined
                : enterStyle(progress(time, 3 + index * 0.55, 4.4 + index * 0.55), 0.45)
            }
          >
            <RealRailItem
              title={row.title}
              participants={participants.slice(0, 2)}
              timeLabel={index === 0 ? "12m" : "34m"}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}

function RealRailItem({
  title,
  participants,
  selected = false,
  working = false,
  timeLabel,
  unreadCount = 0,
}: {
  title: string;
  participants: MeChatRow["participants"];
  selected?: boolean;
  working?: boolean;
  timeLabel?: string;
  unreadCount?: number;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center text-left"
      style={{
        padding: "var(--sp-2) var(--sp-3)",
        gap: "var(--sp-2)",
        background: selected ? "var(--brand-bg)" : "transparent",
        borderLeft: `var(--hairline-bold) solid ${selected ? "var(--brand)" : "transparent"}`,
      }}
    >
      <ChatRowAvatar
        title={title}
        type={participants.length > 2 ? "group" : "direct"}
        participants={participants}
        selfAgentId="human-gandy"
        unreadCount={unreadCount}
        size={26}
        muted
        badge={false}
        statusDot
      />
      <span
        className="min-w-0 flex-1 truncate text-subtitle font-medium"
        style={{
          color: selected || unreadCount > 0 ? "var(--fg)" : "var(--fg-2)",
          fontWeight: unreadCount > 0 ? 700 : 500,
        }}
      >
        {title}
      </span>
      <span className="shrink-0">
        {working ? <ActivityDots /> : <span className="mono text-caption text-fg-4">{timeLabel}</span>}
      </span>
    </button>
  );
}

function Outcome({ visible, children, bottom }: { visible: number; children: ReactNode; bottom?: string }) {
  return (
    <div
      className="absolute inset-x-8 bottom-6 rounded-[var(--radius-panel)] border border-border bg-bg-raised p-5 shadow-[var(--shadow-md)]"
      style={{ ...enterStyle(visible, 1.2), borderLeft: "var(--sp-1) solid var(--brand)", bottom }}
    >
      <p className="text-headline font-semibold">{children}</p>
    </div>
  );
}

function MultiAgentScene({ time }: { time: number }) {
  const offset = ease(progress(time, 25.8, 27.2)) * 80 + ease(progress(time, 31.8, 33.2)) * 84;
  return (
    <div className="relative h-full overflow-hidden">
      <div
        className="mx-auto w-full max-w-3xl px-6 py-3"
        style={{ transform: `translateY(-${offset}px)`, transition: "none" }}
      >
        <TimelineMessage sender="Gandy" seed="human-gandy" at="10:01">
          Add search to the Chats sidebar so users can quickly find a chat by title. Keep the existing navigation
          unchanged and get it ready for review.
        </TimelineMessage>
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="10:01" visible={progress(time, 2, 3)}>
          I’ll own this and bring in the right agents as the work progresses.
        </TimelineMessage>
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="10:02" visible={progress(time, 4.7, 5.5)}>
          <MentionChip name="prism-ux" /> Please define the search interaction and empty state.
        </TimelineMessage>
        {time < 10.2 ? (
          <TimelineWorking
            sender="prism-ux"
            seed="prism-ux"
            body={
              time < 7.5
                ? "Reviewing the current Chats sidebar and keyboard flow…"
                : "Defining search placement and the no-results behavior…"
            }
            visible={progress(time, 5.6, 6.4)}
          />
        ) : (
          <TimelineMessage sender="prism-ux" seed="prism-ux" at="10:04" visible={progress(time, 10.2, 11)}>
            <MentionChip name="nova-lead" /> UX is ready: search sits above the list and preserves keyboard navigation.
          </TimelineMessage>
        )}
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="10:05" visible={progress(time, 12.2, 13)}>
          <MentionChip name="forge-dev" /> Please implement this UX without changing chat navigation.
        </TimelineMessage>
        {time < 21.2 ? (
          <TimelineWorking
            sender="forge-dev"
            seed="forge-dev"
            body={
              time < 15.4
                ? "Inspecting the conversation list and existing navigation state…"
                : time < 17.9
                  ? "Implementing title filtering and the no-results state…"
                  : "Running focused sidebar and keyboard-navigation tests…"
            }
            visible={progress(time, 13.1, 13.9)}
          />
        ) : (
          <TimelineMessage sender="forge-dev" seed="forge-dev" at="10:08" visible={progress(time, 21.2, 22)}>
            <MentionChip name="nova-lead" /> Implemented title filtering and the no-results state.
          </TimelineMessage>
        )}
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="10:09" visible={progress(time, 23.8, 24.6)}>
          <MentionChip name="sentinel-qa" /> Please verify search, selection, and keyboard navigation.
        </TimelineMessage>
        {time < 29.2 ? (
          <TimelineWorking
            sender="sentinel-qa"
            seed="sentinel-qa"
            body="Verifying search, selection, and keyboard navigation…"
            visible={progress(time, 24.7, 25.5)}
          />
        ) : (
          <TimelineMessage sender="sentinel-qa" seed="sentinel-qa" at="10:12" visible={progress(time, 29.2, 30)}>
            <MentionChip name="nova-lead" /> All checks pass. Existing chat navigation is unchanged.
          </TimelineMessage>
        )}
        <TimelineMessage sender="nova-lead" seed="nova-lead" at="10:13" visible={progress(time, 31, 31.8)}>
          <MentionChip name="Gandy" /> The feature is implemented and verified. PR {"#"}128 is ready for review.
        </TimelineMessage>
      </div>
    </div>
  );
}

function TimelineMessage({
  sender,
  seed,
  at,
  visible = 1,
  children,
}: {
  sender: string;
  seed: string;
  at: string;
  visible?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1_5) 0",
        ...enterStyle(visible, 0.45),
      }}
    >
      <Avatar name={sender} seed={seed} size={20} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline" style={{ gap: 8 }}>
          <span
            className="mono text-body font-semibold"
            style={{ color: sender === "Gandy" ? "var(--fg)" : "var(--primary)" }}
          >
            {sender}
          </span>
          <span className="mono text-caption text-fg-4">{at}</span>
        </div>
        <div className="text-body leading-relaxed" style={{ color: "var(--fg)", marginTop: 2 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function MentionChip({ name }: { name: string }) {
  return (
    <span className="mention-chip" data-mention-name={name}>
      <span className="mention-chip-display">@{name}</span>
    </span>
  );
}

function TimelineWorking({
  sender,
  seed,
  body,
  visible,
}: {
  sender: string;
  seed: string;
  body: ReactNode;
  visible: number;
}) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1) 0",
        ...enterStyle(visible, 0.45),
      }}
    >
      <Avatar name={sender} seed={seed} size={20} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline" style={{ gap: 6 }}>
          <span className="mono text-label font-semibold text-primary">{sender}</span>
          <StatusGlyph colorVar="var(--state-working)" shape="dot" pulse="working" size={8} />
          <span className="mono text-caption text-state-working">
            <span className="font-semibold">working</span> · now
          </span>
        </div>
        <div className="text-body mt-0.5">{body}</div>
      </div>
    </div>
  );
}

const ISSUE_NUMBER = `#${482}`;
const ISSUE_TITLE = "Improve onboarding captions";
const PR_NUMBER = `#${487}`;
const PR_TITLE = "Make onboarding transitions explain their value";
const GITHUB_CHAT_TITLE = `Issue first-tree-web${ISSUE_NUMBER}: ${ISSUE_TITLE}`;

const ISSUE_TASK_CARD: GithubEventCard = {
  type: "github_event",
  reason: "assigned",
  event: "issues",
  action: "assigned",
  kind: "assigned",
  repository: "acme/first-tree-web",
  sender: "maya-reviewer",
  title: `Issue ${ISSUE_NUMBER}: ${ISSUE_TITLE}`,
  body: "Make each caption explain why the visible transition matters, and keep it clear of key UI.",
  url: "https://github.com/acme/first-tree-web/issues/482",
  entity: {
    type: "issue",
    key: `acme/first-tree-web${ISSUE_NUMBER}`,
    url: "https://github.com/acme/first-tree-web/issues/482",
  },
  mentionedUser: "gandy",
};

const PR_OPENED_CARD: GithubEventCard = {
  ...ISSUE_TASK_CARD,
  reason: "subscribed",
  event: "pull_request",
  action: "opened",
  kind: "opened",
  sender: "gandy",
  title: `PR ${PR_NUMBER}: ${PR_TITLE}`,
  body: `Fixes ${ISSUE_NUMBER}. Make each caption explain why the visible transition matters.`,
  url: "https://github.com/acme/first-tree-web/pull/487",
  entity: {
    type: "pull_request",
    key: `acme/first-tree-web${PR_NUMBER}`,
    url: "https://github.com/acme/first-tree-web/pull/487",
  },
  mentionedUser: undefined,
};

const PR_REVIEW_CARD: GithubEventCard = {
  ...PR_OPENED_CARD,
  reason: "subscribed",
  event: "pull_request_review_comment",
  action: "created",
  kind: "review_comment",
  sender: "maya-reviewer",
  title: `PR ${PR_NUMBER}: ${PR_TITLE}`,
  body: "Please shorten the final caption and keep the merged state visible.",
  url: "https://github.com/acme/first-tree-web/pull/487#discussion_r2048",
  entity: {
    type: "pull_request",
    key: `acme/first-tree-web${PR_NUMBER}`,
    url: "https://github.com/acme/first-tree-web/pull/487",
  },
  mentionedUser: undefined,
};

const PR_UPDATED_CARD: GithubEventCard = {
  ...PR_REVIEW_CARD,
  reason: "subscribed",
  event: "pull_request",
  action: "synchronize",
  kind: "synchronized",
  sender: "gandy",
  body: "Shortened the final caption and updated the focused tests.",
  url: "https://github.com/acme/first-tree-web/pull/487",
  mentionedUser: undefined,
};

const PR_APPROVAL_CARD: GithubEventCard = {
  ...PR_REVIEW_CARD,
  reason: "subscribed",
  event: "pull_request_review",
  action: "submitted",
  kind: "reviewed",
  sender: "maya-reviewer",
  body: "Approved — the captions are concise and the merged state stays visible.",
  url: "https://github.com/acme/first-tree-web/pull/487#pullrequestreview-2317",
  mentionedUser: undefined,
};

function GithubScene({ time }: { time: number }) {
  const offset = smoothstep(progress(time, 17.5, 24.15)) * 302;
  return (
    <div className="relative h-full overflow-hidden">
      <div
        className="mx-auto w-full max-w-3xl px-7 py-4"
        style={{ transform: `translateY(-${offset}px)`, transition: "none" }}
      >
        <GithubTimelineEvent content={ISSUE_TASK_CARD} at="10:14" visible={progress(time, 2.4, 3.3)} />
        {time < 9.9 ? (
          <TimelineWorking
            sender="nova-lead"
            seed="nova-lead"
            body={
              time < 6.8
                ? "Reading the Issue and planning the caption update…"
                : "Implementing the update and running focused regression tests…"
            }
            visible={progress(time, 4.2, 5)}
          />
        ) : (
          <TimelineMessage sender="nova-lead" seed="nova-lead" at="10:19" visible={progress(time, 9.5, 10.3)}>
            Implemented the caption changes and opened PR {PR_NUMBER} with Fixes {ISSUE_NUMBER}.
          </TimelineMessage>
        )}
        <GithubTimelineEvent content={PR_OPENED_CARD} at="10:20" visible={progress(time, 11.2, 12)} />
        <GithubTimelineEvent content={PR_REVIEW_CARD} at="10:27" visible={progress(time, 14, 14.8)} />
        {time < 19.6 ? (
          <TimelineWorking
            sender="nova-lead"
            seed="nova-lead"
            body={
              time < 17.8
                ? "Applying the review feedback in the same GitHub-linked Chat…"
                : "Review update complete; running focused tests before publishing…"
            }
            visible={progress(time, 15.8, 16.6)}
          />
        ) : (
          <TimelineMessage sender="nova-lead" seed="nova-lead" at="10:31" visible={progress(time, 19.2, 20)}>
            Review feedback addressed. Pushed the update to PR {PR_NUMBER}.
          </TimelineMessage>
        )}
        <GithubTimelineEvent content={PR_UPDATED_CARD} at="10:32" visible={progress(time, 20.4, 21.2)} />
        <GithubTimelineEvent content={PR_APPROVAL_CARD} at="10:34" visible={progress(time, 22.4, 23.2)} />
      </div>
      <Outcome visible={progress(time, 24.4, 25.2)} bottom="6rem">
        Assign the Issue in GitHub. First Tree creates the Chat, starts the Agent, and keeps the work connected through
        merge.
      </Outcome>
    </div>
  );
}

function GithubTimelineEvent({ content, at, visible }: { content: GithubEventCard; at: string; visible: number }) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-2) 0",
        ...enterStyle(visible, 0.45),
      }}
    >
      <GithubSystemAvatar size={20} />
      <div className="min-w-0">
        <div className="mb-1 flex items-baseline" style={{ gap: "var(--sp-2)" }}>
          <span className="mono text-body font-semibold">GitHub</span>
          <span className="mono text-caption text-fg-4">{at}</span>
        </div>
        <GithubEventCardMessage content={content} />
      </div>
    </div>
  );
}

function Composer() {
  return (
    <div className="shrink-0 border-t border-border bg-bg-raised p-3">
      <div className="flex min-h-12 items-center rounded-[var(--radius-input)] border border-border bg-background px-3 text-label text-fg-4">
        Message Nova…
        <Paperclip className="ml-auto size-4" />
        <span className="ml-2 flex size-7 items-center justify-center rounded-[var(--radius-input)] bg-primary text-primary-foreground">
          <Send className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

function RightSidebar({ chapterId, time }: { chapterId: ChapterId; time: number }) {
  if (chapterId === "github") {
    return <GithubChapterSidebar time={time} />;
  }

  const participantCount = 2 + Number(time >= 4.7) + Number(time >= 12.2) + Number(time >= 23.8);
  return (
    <aside className="w-75 shrink-0 overflow-hidden border-l border-border bg-bg-raised">
      <section className="border-b border-border-faint">
        <div className="px-3 pb-1 pt-2.5 text-eyebrow text-fg-4">
          Participants <span className="mono">· {participantCount}</span>
        </div>
        <div className="flex flex-col px-2 pb-1" style={{ gap: 2 }}>
          <ParticipantStatusRow name="nova-lead" status={time < 31 ? "Working" : "Idle"} />
          {time >= 4.7 ? <ParticipantStatusRow name="prism-ux" status={time < 10.2 ? "Working" : "Idle"} /> : null}
          {time >= 12.2 ? <ParticipantStatusRow name="forge-dev" status={time < 21.2 ? "Working" : "Idle"} /> : null}
          {time >= 23.8 ? <ParticipantStatusRow name="sentinel-qa" status={time < 29.2 ? "Working" : "Idle"} /> : null}
          <ParticipantStatusRow name="Gandy" human />
        </div>
        <div className="px-2 pb-2 pt-1">
          <div className="flex items-center px-2 py-1.5 text-fg-3" style={{ gap: "var(--sp-2_5)" }}>
            <UserPlus size={16} />
            <span className="text-body">Add</span>
          </div>
        </div>
      </section>
      {time >= 31 ? <FixtureGitHubSection visible={progress(time, 31, 32.2)} /> : null}
    </aside>
  );
}

function GithubChapterSidebar({ time }: { time: number }) {
  const merged = time >= 24;
  const working = (time >= 4.2 && time < 10.8) || (time >= 15.8 && time < 20.2);
  const prVisible = time >= 10.5;
  return (
    <aside className="shrink-0 overflow-hidden border-l border-border bg-bg-raised" style={{ width: 300 }}>
      <section className="border-b border-border-faint">
        <div className="px-3 pb-1 pt-2.5 text-eyebrow text-fg-4">
          Participants <span className="mono">· 2</span>
        </div>
        <div className="flex flex-col px-2 pb-2" style={{ gap: 2 }}>
          <ParticipantStatusRow name="nova-lead" status={working ? "Working" : "Idle"} />
          <ParticipantStatusRow name="Gandy" human />
        </div>
      </section>
      <section style={enterStyle(progress(time, 2, 2.4), 0.35)}>
        <div className="px-3 pb-1 pt-2.5 text-eyebrow text-fg-4">
          GitHub <span className="mono">· {prVisible ? 2 : 1}</span>
        </div>
        <div className="flex flex-col px-2 pb-2" style={{ gap: "var(--sp-1_5)" }}>
          {prVisible ? (
            <div style={enterStyle(progress(time, 10.5, 11.1), 0.4)}>
              <GithubEntityRow
                icon={merged ? GitMerge : GitPullRequest}
                entityType="PR"
                title={PR_TITLE}
                reference={PR_NUMBER}
                state={merged ? "Merged" : "Open"}
              />
            </div>
          ) : null}
          <GithubEntityRow
            icon={CircleDot}
            entityType="Issue"
            title={ISSUE_TITLE}
            reference={ISSUE_NUMBER}
            state={merged ? "Closed" : "Open"}
          />
        </div>
      </section>
    </aside>
  );
}

function GithubEntityRow({
  icon: EntityIcon,
  entityType,
  title,
  reference,
  state,
}: {
  icon: LucideIcon;
  entityType: "Issue" | "PR";
  title: string;
  reference: string;
  state: "Open" | "Closed" | "Merged";
}) {
  const open = state === "Open";
  return (
    <div
      className="group flex items-start px-2 py-1.5"
      style={{ gap: "var(--sp-2)", borderRadius: "var(--radius-input)" }}
    >
      <EntityIcon
        size={16}
        strokeWidth={1.75}
        className="mt-0.5 shrink-0"
        style={{ color: open ? "var(--fg-success-strong)" : state === "Merged" ? "var(--primary)" : "var(--fg-3)" }}
      />
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <div className="text-body text-foreground">{title}</div>
        <div className="mono flex items-center text-caption text-fg-3" style={{ gap: "var(--sp-1_5)" }}>
          <span className="font-medium">
            {entityType} {reference}
          </span>
          <span aria-hidden className="text-fg-4">
            ·
          </span>
          <span
            style={{ color: open ? "var(--fg-success-strong)" : state === "Merged" ? "var(--primary)" : undefined }}
          >
            {state}
          </span>
        </div>
      </div>
      <ExternalLink size={12} className="mt-1 shrink-0 opacity-0" />
    </div>
  );
}

function ParticipantStatusRow({
  name,
  status,
  human = false,
}: {
  name: string;
  status?: "Working" | "Idle";
  human?: boolean;
}) {
  const working = status === "Working";
  return (
    <div
      className="flex items-center"
      style={{ gap: "var(--sp-2_5)", padding: "var(--sp-1_25) var(--sp-2)", borderRadius: "var(--radius-input)" }}
    >
      <span className="relative block size-7 shrink-0">
        <Avatar name={name} seed={name} size={28} />
        {!human ? (
          <span className="absolute -bottom-0.5 -right-0.5">
            <StatusGlyph
              colorVar={working ? "var(--state-working)" : "var(--state-idle)"}
              shape="dot"
              pulse={working ? "working" : null}
              size={9}
              separator
            />
          </span>
        ) : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <div className="truncate text-subtitle">{name}</div>
        {!human ? (
          <div className="text-caption" style={{ color: working ? "var(--state-working)" : "var(--state-idle)" }}>
            {status}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FixtureGitHubSection({ visible }: { visible: number }) {
  return (
    <section style={enterStyle(visible, 0.5)}>
      <div className="px-3 pb-1 pt-2.5 text-eyebrow text-fg-4">
        GitHub <span className="mono">· 1</span>
      </div>
      <div className="flex flex-col px-2 pb-2" style={{ gap: "var(--sp-1_5)" }}>
        <div
          className="group flex items-start px-2 py-1.5"
          style={{ gap: "var(--sp-2)", borderRadius: "var(--radius-input)" }}
        >
          <GitPullRequest size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-success" />
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
            <div className="text-body text-foreground">Add chat-title search</div>
            <div className="mono flex items-center text-label text-fg-3" style={{ gap: "var(--sp-1_5)" }}>
              <span className="truncate">first-tree{"#"}128</span>
              <DenseBadge tone="accent">Open</DenseBadge>
            </div>
          </div>
          <ExternalLink size={12} className="mt-1 shrink-0 opacity-0" />
        </div>
      </div>
    </section>
  );
}
