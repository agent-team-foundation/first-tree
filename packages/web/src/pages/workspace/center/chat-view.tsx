import {
  extractMentions,
  type MentionParticipant,
  type QuestionAnswerMessageContent,
  type QuestionMessageContent,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, AtSign, Check, ExternalLink, Eye, MessageSquare, Paperclip, Plus, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getActivityOverview } from "../../../api/activity.js";
import {
  type FileMessageContent,
  getChat,
  type ImageRefContent,
  listChatMessages,
  type MessageWithDelivery,
  readFileAsBase64,
  renameChat,
  sendChatMessage,
  sendFileMessage,
} from "../../../api/chats.js";
import { getImage, putImage } from "../../../api/image-store.js";
import { addMeChatParticipants } from "../../../api/me-chats.js";
import { cacheMessages, getCachedMessages } from "../../../api/message-store.js";
import { getReadState, type ReadState, setReadState } from "../../../api/read-state-store.js";
import {
  agentSessionsQueryKey,
  asAssistantTextPayload,
  asErrorPayload,
  asToolCallPayload,
  listSessionEvents,
  type SessionEventRow,
} from "../../../api/sessions.js";
import { useAuth } from "../../../auth/auth-context.js";
import {
  isQuestionAnswerContent,
  isQuestionContent,
  QuestionMessage,
  type QuestionStatus,
} from "../../../components/chat/question-message.js";
import { FirstTreeLogo } from "../../../components/first-tree-logo.js";
import { HistoryGapBanner } from "../../../components/history-gap-banner.js";
import {
  ambiguousDisplayNames,
  groupAndSortCandidates,
  MentionAutocompletePopover,
  type MentionCandidate,
  MentionLabel,
  useMentionAutocomplete,
} from "../../../components/mention-autocomplete.js";
import { NewMessagesPill } from "../../../components/new-messages-pill.js";
import { Button } from "../../../components/ui/button.js";
import { Markdown } from "../../../components/ui/markdown.js";
import { UnreadDivider } from "../../../components/unread-divider.js";
import { useChatScroll } from "../../../hooks/use-chat-scroll.js";
import { useReadTracker } from "../../../hooks/use-read-tracker.js";
import { useAgentIdentityMap, useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { useAutoResizeTextarea } from "../../../lib/use-autoresize-textarea.js";
import { cn } from "../../../lib/utils.js";
import { filterEventsForTimeline } from "../../../utils/session-timeline.js";

function formatClockTime(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function previewArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "…";
  }
}

function ReadReceipt({ msg, myAgentId }: { msg: MessageWithDelivery; myAgentId: string | null }) {
  if (!myAgentId || msg.senderId !== myAgentId) return null;
  const status = msg.deliveryStatus ?? "sent";
  if (status === "acked") {
    return (
      <span className="mono text-caption" style={{ color: "var(--accent)" }} title="Agent has started processing">
        ✓✓ read
      </span>
    );
  }
  if (status === "delivered") {
    return (
      <span className="mono text-caption" style={{ color: "var(--fg-3)" }} title="Delivered to agent inbox">
        ✓✓
      </span>
    );
  }
  return (
    <span className="mono text-caption" style={{ color: "var(--fg-4)" }} title="Sent">
      ✓ sent
    </span>
  );
}

/**
 * Compact, single-line "status indicator" for a tool call. Per the chat-view
 * design, we don't show the tool's full args/result — only a "Using <name>…"
 * pulse while the turn is in progress. When the turn ends, the whole row is
 * hidden by the turn-grouping filter (see `activeSince` below).
 */
function ToolCallStatusRow({ event }: { event: SessionEventRow }) {
  const payload = asToolCallPayload(event.payload);
  if (!payload) return null;
  const isErr = payload.status === "error";
  const isPending = payload.status === "pending";
  const color = isErr ? "var(--state-error)" : isPending ? "var(--state-blocked)" : "var(--fg-3)";
  const verb = isErr ? "failed" : isPending ? "using" : "used";
  return (
    <div
      className="mono flex items-center text-label"
      style={{
        gap: 8,
        padding: "var(--sp-0_5) var(--sp-2)",
        color: "var(--fg-3)",
      }}
    >
      {isPending ? (
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            animation: "heartbeat-pulse 1.2s ease-in-out infinite",
            flexShrink: 0,
            marginTop: 5,
          }}
        />
      ) : (
        <span aria-hidden style={{ color, flexShrink: 0 }}>
          {isErr ? "⚠" : "↳"}
        </span>
      )}
      <span
        className="flex items-baseline"
        style={{ color: "var(--fg-3)", minWidth: 0, flex: 1 }}
        title={payload.args !== undefined && payload.args !== null ? previewArgs(payload.args) : undefined}
      >
        <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
          {verb} <span style={{ color: "var(--fg-2)" }}>{payload.name}</span>
        </span>
        {payload.args !== undefined && payload.args !== null ? (
          <span className="truncate" style={{ color: "var(--fg-4)", minWidth: 0, flex: 1 }}>
            ({previewArgs(payload.args)})
          </span>
        ) : null}
        {payload.durationMs !== undefined && !isPending ? (
          <span
            className="text-caption"
            style={{
              color: "var(--fg-4)",
              marginLeft: 6,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            · {formatDuration(payload.durationMs)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Intermediate assistant reply text surfaced while a turn is still running.
 * These rows are hidden by the turn-grouping filter once the turn ends —
 * the final result is delivered as a regular chat message.
 */
function AssistantTextRow({
  event,
  agentNameFn,
  agentId,
}: {
  event: SessionEventRow;
  agentNameFn: (id: string) => string;
  agentId: string;
}) {
  const payload = asAssistantTextPayload(event.payload);
  if (!payload || payload.text.length === 0) return null;
  const senderName = agentNameFn(agentId);
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1) 0",
        opacity: 0.85,
      }}
    >
      <Avatar name={senderName} isSelf={false} />
      <div className="min-w-0">
        <div className="flex items-baseline" style={{ gap: 8 }}>
          <span className="mono text-label font-semibold" style={{ color: "var(--accent)" }}>
            {senderName}
          </span>
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            {formatClockTime(event.createdAt)}
          </span>
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            · streaming
          </span>
        </div>
        <div
          className="text-body"
          style={{
            color: "var(--fg-2)",
            whiteSpace: "pre-wrap",
            marginTop: 2,
          }}
        >
          {payload.text}
        </div>
      </div>
    </div>
  );
}

/**
 * Lightweight "Thinking…" pulse. The actual thinking content is never
 * transmitted — the backend emits a bare marker and we surface it as a
 * single-line status. Hidden once the turn ends.
 */
function ThinkingRow({ event }: { event: SessionEventRow }) {
  return (
    <div
      className="mono flex items-center text-label"
      style={{
        gap: 8,
        padding: "var(--sp-0_5) var(--sp-2)",
        color: "var(--fg-3)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--accent)",
          animation: "heartbeat-pulse 1.2s ease-in-out infinite",
          flexShrink: 0,
        }}
      />
      <span style={{ color: "var(--fg-3)" }}>thinking…</span>
      <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
        {formatClockTime(event.createdAt)}
      </span>
    </div>
  );
}

function ErrorRow({ event }: { event: SessionEventRow }) {
  const payload = asErrorPayload(event.payload);
  const ts = formatClockTime(event.createdAt);
  return (
    <div
      style={{
        padding: "var(--sp-1_5) var(--sp-2_5)",
        borderLeft: "var(--hairline-bold) solid var(--state-error)",
        background: "color-mix(in oklch, var(--state-error) 6%, transparent)",
        borderRadius: "0 var(--radius-input) var(--radius-input) 0",
      }}
    >
      <div className="mono uppercase text-caption" style={{ color: "var(--state-error)" }}>
        error · {payload?.source ?? "unknown"} · {ts}
      </div>
      <div
        className="text-label"
        style={{
          marginTop: 2,
          color: "var(--fg-2)",
          whiteSpace: "pre-wrap",
        }}
      >
        {payload?.message ?? "(invalid error payload)"}
      </div>
    </div>
  );
}

function Avatar({ name, isSelf }: { name: string; isSelf: boolean }) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div
      className="mono text-eyebrow font-bold"
      style={{
        width: 20,
        height: 20,
        borderRadius: "var(--radius-input)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        background: isSelf ? "linear-gradient(135deg, var(--accent), oklch(0.58 0.14 170))" : "var(--bg-active)",
        border: isSelf ? "none" : "var(--hairline) solid var(--border-strong)",
        color: isSelf ? "oklch(0.14 0.01 150)" : "var(--fg-2)",
      }}
    >
      {isSelf ? initials : <FirstTreeLogo width={9} height={10} style={{ color: "var(--accent)" }} />}
    </div>
  );
}

function TextRow({
  msg,
  myAgentId,
  agentNameFn,
}: {
  msg: MessageWithDelivery;
  myAgentId: string | null;
  agentNameFn: (id: string) => string;
}) {
  const senderName = agentNameFn(msg.senderId);
  const isSelf = myAgentId === msg.senderId;

  return (
    <div
      className="grid"
      data-message-id={msg.id}
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1_5) 0",
      }}
    >
      <Avatar name={senderName} isSelf={isSelf} />
      <div className="min-w-0">
        <div className="flex items-baseline" style={{ gap: 8 }}>
          <span
            className="mono text-body font-semibold"
            style={{
              color: isSelf ? "var(--fg)" : "var(--accent)",
            }}
          >
            {senderName}
          </span>
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            {formatClockTime(msg.createdAt)}
          </span>
          <span style={{ marginLeft: "auto" }}>
            <ReadReceipt msg={msg} myAgentId={myAgentId} />
          </span>
        </div>
        <div
          className="text-body"
          style={{
            color: "var(--fg)",
            marginTop: 2,
          }}
        >
          {msg.format === "file" && isInlineImageContent(msg.content) ? (
            <img
              src={`data:${msg.content.mimeType};base64,${msg.content.data}`}
              alt={msg.content.filename ?? "image"}
              style={{ maxWidth: 320, borderRadius: "var(--radius-panel)", marginTop: 4 }}
            />
          ) : msg.format === "file" && isImageRefContent(msg.content) ? (
            <ImageFromRef content={msg.content} />
          ) : msg.format === "text" ? (
            <Markdown>{typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}</Markdown>
          ) : (
            <pre
              className="mono text-label"
              style={{
                background: "var(--bg-sunken)",
                padding: 8,
                borderRadius: "var(--radius-input)",
                overflow: "auto",
                maxHeight: 160,
              }}
            >
              {JSON.stringify(msg.content, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function isInlineImageContent(content: unknown): content is FileMessageContent {
  if (typeof content !== "object" || content === null) return false;
  const c = content as Record<string, unknown>;
  return typeof c.data === "string" && typeof c.mimeType === "string" && (c.mimeType as string).startsWith("image/");
}

function isImageRefContent(content: unknown): content is ImageRefContent {
  if (typeof content !== "object" || content === null) return false;
  const c = content as Record<string, unknown>;
  return (
    typeof c.imageId === "string" &&
    typeof c.mimeType === "string" &&
    (c.mimeType as string).startsWith("image/") &&
    typeof c.filename === "string"
  );
}

/**
 * Render an image whose bytes live in per-browser IndexedDB. Cache hit →
 * inline preview; miss → placeholder text (cross-device or cleared cache).
 */
function ImageFromRef({ content }: { content: ImageRefContent }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "hit"; src: string } | { kind: "miss" }>({
    kind: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    getImage(content.imageId).then((hit) => {
      if (cancelled) return;
      if (hit) {
        setState({ kind: "hit", src: `data:${hit.mimeType};base64,${hit.base64}` });
      } else {
        setState({ kind: "miss" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [content.imageId]);

  if (state.kind === "hit") {
    return (
      <img
        src={state.src}
        alt={content.filename}
        style={{ maxWidth: 320, borderRadius: "var(--radius-panel)", marginTop: 4 }}
      />
    );
  }
  if (state.kind === "miss") {
    return (
      <span className="text-label" style={{ color: "var(--fg-3)", fontStyle: "italic" }}>
        [Image "{content.filename}" not available on this device]
      </span>
    );
  }
  return (
    <span className="text-label" style={{ color: "var(--fg-4)" }}>
      …
    </span>
  );
}

function QuestionMessageRow({
  msg,
  chatId,
  content,
  answer,
  status,
  agentNameFn,
}: {
  msg: MessageWithDelivery;
  chatId: string;
  content: QuestionMessageContent;
  answer: QuestionAnswerMessageContent | null;
  status: QuestionStatus;
  agentNameFn: (id: string) => string;
}) {
  const senderName = agentNameFn(msg.senderId);
  return (
    <div
      className="grid"
      data-message-id={msg.id}
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1_5) 0",
      }}
    >
      <Avatar name={senderName} isSelf={false} />
      <div className="min-w-0 flex flex-col" style={{ gap: "var(--sp-1)" }}>
        <div className="flex items-baseline" style={{ gap: 8 }}>
          <span className="mono text-body font-semibold" style={{ color: "var(--accent)" }}>
            {senderName}
          </span>
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            {formatClockTime(msg.createdAt)}
          </span>
        </div>
        <QuestionMessage chatId={chatId} questionMessageId={msg.id} content={content} answer={answer} status={status} />
      </div>
    </div>
  );
}

/** Compact recap row for `format=question_answer`. Mirrors the style of a
 *  user text reply but flagged so it's clear this came from the answer card. */
function QuestionAnswerRow({ msg, agentNameFn }: { msg: MessageWithDelivery; agentNameFn: (id: string) => string }) {
  const parsed = isQuestionAnswerContent(msg.content) ? msg.content : null;
  const senderName = agentNameFn(msg.senderId);
  const summary = parsed
    ? Object.entries(parsed.answers)
        .map(([q, a]) => `${q.replace(/\s+\?$/u, "?")}: ${a}`)
        .join(" · ")
    : "(answer)";
  return (
    <div
      className="grid"
      data-message-id={msg.id}
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1_5) 0",
      }}
    >
      <Avatar name={senderName} isSelf />
      <div className="min-w-0">
        <div className="flex items-baseline" style={{ gap: 8 }}>
          <span className="mono text-body font-semibold" style={{ color: "var(--fg)" }}>
            {senderName}
          </span>
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            {formatClockTime(msg.createdAt)}
          </span>
          <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
            answered question
          </span>
        </div>
        <div className="text-body" style={{ color: "var(--fg-2)", marginTop: 2 }}>
          {summary}
        </div>
      </div>
    </div>
  );
}

type PendingImage = {
  id: string;
  file: File;
  previewUrl: string;
};

type TimelineItem =
  | { kind: "message"; at: string; key: string; data: MessageWithDelivery }
  | { kind: "event"; at: string; key: string; data: SessionEventRow };

/**
 * Renders a small "↗ View on GitHub" link beside the chat title when the chat
 * was created by the GitHub webhook router. Reads `metadata.entityUrl` (set by
 * `services/github-entity-chat.ts::createEntityChat`); shows nothing if the
 * chat has no entity metadata or the URL is missing.
 *
 * Defensive parsing: `metadata` is typed `Record<string, unknown>` on the
 * wire, so we narrow inline rather than trust the shape. A schema parse would
 * be ideologically purer but the cost of pulling Zod into a render path for a
 * 2-field check isn't worth it.
 */
function EntityLink({ metadata }: { metadata: Record<string, unknown> | undefined }) {
  if (!metadata || metadata.source !== "github") return null;
  const url = typeof metadata.entityUrl === "string" ? metadata.entityUrl : null;
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="View on GitHub"
      className="inline-flex items-center"
      style={{ color: "var(--fg-3)", padding: "0 var(--sp-1)", textDecoration: "none" }}
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

export function ChatView({
  agentId,
  chatId,
  readOnly = false,
  titleFallback,
  joinAction,
}: {
  agentId: string;
  chatId: string;
  /** When true, render watching mode: timeline only, no rename, no [+] participant,
   *  composer slot replaced with a Join panel. */
  readOnly?: boolean;
  /** Pre-loaded title shown while `chatDetail` is still fetching — typically
   *  the row's `title` from the `me/chats` cache the chat list already has hot.
   *  Without it, the header flashes "…" on every cold open. */
  titleFallback?: string | null;
  /** Bundled join contract: when present in `readOnly`, the Join panel renders
   *  the button + inline error/loading. All three travel together — passing
   *  `error` without `onJoin` would render a dead error with no recovery. */
  joinAction?: {
    onJoin: () => void;
    joining: boolean;
    error: string | null;
  };
}) {
  const queryClient = useQueryClient();
  const agentName = useAgentNameMap();
  const agentIdentity = useAgentIdentityMap();
  const { agentId: myAgentId } = useAuth();
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Scrollable container that holds the message timeline. Ref is wired
  // up on the corresponding <div> below; consumed by useChatScroll (for
  // ResizeObserver-stabilised scrolling) and useReadTracker (as the
  // IntersectionObserver root).
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // useChatScroll is declared up here (rather than alongside the M2
  // jump-to-position logic below) because `sendMut`'s onSuccess
  // needs to call `scrollToBottom` — and sendMut is declared
  // shortly after this point. The hook only depends on
  // `scrollContainerRef`, which is just a ref.
  const { scrollToBottomImmediate, scrollToMessageImmediate, scrollToBottom, isAtBottom } =
    useChatScroll(scrollContainerRef);

  // Auto-grow the composer up to the CSS `max-height` cap (10.5rem ≈ 8
  // visible lines). Same hook as the new-chat composer for a consistent
  // typing experience across both entry points.
  useAutoResizeTextarea(textareaRef, draft);
  /** Once-per-chat guard for the focus auto-prime: after the user has
   * focused the input even once, we don't keep slapping `@` back into an
   * empty draft. Reset when switching chats. */
  const focusPrimedRef = useRef(false);
  /** Once-per-session set of chatIds we've pre-filled. Set semantics
   * (not a single ref) so revisiting an empty chat we already touched
   * doesn't re-stamp the greeting on top of the user's cleared draft.
   * Persists for the life of the ChatView component. */
  const prefilledChatsRef = useRef<Set<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is intentionally chatId-scoped.
  useEffect(() => {
    focusPrimedRef.current = false;
  }, [chatId]);

  // Hydrate timeline from local IndexedDB cache so chat-switches feel
  // instant (no spinner-then-content flash). Cache scope is messages only;
  // session_events / session_outputs are session-lifecycle scoped on the
  // server (see agent-hub/client-runtime.md) and intentionally not cached.
  // staleTime: Infinity — cache lookup never re-fetches; React Query's
  // gcTime keeps the result in memory for instant re-display when the user
  // bounces between chats.
  const { data: cachedMessages } = useQuery({
    queryKey: ["chat-messages-cache", chatId],
    queryFn: () => getCachedMessages(chatId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Server fetch — same 5s polling as before, plus a fire-and-forget
  // write-through to the cache so subsequent opens hit hot. The cache
  // write is intentionally not awaited: it must never delay rendering or
  // surface as an error to the user; on IndexedDB unavailability it
  // silently no-ops.
  //
  // TODO(perf): the write-through re-upserts all 50 messages every 5s
  // (~600 idempotent IDB puts/min/chat). Functionally correct because
  // upsert is keyed by [chatId, messageId], but most writes overwrite
  // identical rows. A future iteration can diff against the cached set
  // and only write rows whose id is new or whose deliveryStatus changed.
  // Flagged by yuezengwu in PR 286 review — non-blocking.
  const { data: messagesData } = useQuery({
    queryKey: ["chat-messages", chatId],
    queryFn: async () => {
      const fresh = await listChatMessages(chatId, { limit: 50 });
      void cacheMessages(chatId, fresh.items);
      return fresh;
    },
    refetchInterval: 5_000,
  });

  // Fetch newest events first so the turn-grouping filter always sees the
  // latest `turn_end` even in chats with thousands of total events. The
  // timeline renderer later sorts by timestamp, so the fetch order is moot
  // for display — only the contents of the window matter.
  const { data: eventsData } = useQuery({
    queryKey: ["session-events", agentId, chatId],
    queryFn: () => listSessionEvents(agentId, chatId, { limit: 200, direction: "desc" }),
    refetchInterval: 5_000,
  });

  const { data: chatDetail } = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    enabled: !!chatId,
  });

  /** Org-wide agent list for the `@` picker. We surface every agent the
   *  user can address — not just current chat participants — so `@`-ing
   *  someone outside the chat acts as both an invite and a mention. */
  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 15_000,
  });

  // Pre-advance target for the session high water: the id of a
  // message the USER just sent (text-only or file path). The actual
  // `setSessionHighestId` call happens in an effect further down,
  // because `setSessionHighestId` is declared below this point with
  // the rest of the tracker/pill state — both paths surface a
  // pending advance here, the effect drains it.
  //
  // Why pre-advance is the right mechanism: without it, after the
  // server returns the new message and `mergedMessages` grows, the
  // tracker still reports the PREVIOUS last-visible message as the
  // bottom-visible until the smooth-scroll animation reaches the
  // new row. During that ~300ms window, `pillCount = 1` and the
  // pill flashes "↓ 1 new message" for the user's own send. By
  // bumping `sessionHighestId` to the new message's id immediately
  // on `onSuccess`, `pillCount` stays 0 from the very first render
  // that contains the new message — no flash possible.
  //
  // The `chatId` is tracked alongside the message id so a send
  // whose response arrives AFTER the user has switched chats
  // doesn't pollute the new chat's watermark. Per PR 286 manual
  // sign-off rev 10 (reviewer's option C).
  const [pendingHighWaterAdvance, setPendingHighWaterAdvance] = useState<{ chatId: string; messageId: string } | null>(
    null,
  );

  const sendMut = useMutation({
    mutationFn: (content: string) => sendChatMessage(chatId, content),
    onSuccess: (sentMessage) => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["chat-messages", chatId] });
      // Refresh the workspace sidebar the moment the message is durable —
      // server's predictive Step 1b (in services/message.ts) just upserted an
      // `active` agent_chat_sessions row, so the new chat now satisfies the
      // listAgentSessions INNER JOIN. Without this invalidate the user would
      // wait up to 10s for the polling refetch. See M plan Step 3 in
      // docs/session-creation-on-first-message.md.
      queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(agentId) });
      // Persist the own-send advance to chat-A's read-state row
      // both in the React Query cache and in IndexedDB, keyed by
      // the `chatId` captured in this closure at send time. The
      // direct write makes the snapshot durable even if the user
      // switches chats before the tracker's debounce window
      // settles. The just-sent message is, under UUID v7, also the
      // chat tip — so `latestKnownMessageId = sentMessage.id` is
      // both the visual anchor and the freshness marker.
      const ownSendReadState: ReadState = {
        chatId,
        bottomVisibleMessageId: sentMessage.id,
        latestKnownMessageId: sentMessage.id,
        updatedAt: Date.now(),
      };
      queryClient.setQueryData<ReadState>(["chat-read-state", chatId], ownSendReadState);
      void setReadState(chatId, sentMessage.id, sentMessage.id);
      // Pre-advance the in-memory high water to the new message id
      // BEFORE initiating the smooth scroll. By the time the new
      // message commits to `mergedMessages`, `sessionHighestIdx`
      // already resolves to the new last index → `pillCount = 0` →
      // pill never flashes for the user's own send.
      setPendingHighWaterAdvance({ chatId, messageId: sentMessage.id });
      // When the user sends a message, scroll all the way to the
      // bottom so they see their own send. ResizeObserver-debounced
      // (non-immediate) variant so the scroll lands after the
      // newly-arrived message has been rendered. Without this,
      // M2's once-per-chat-visit gate would suppress any scroll
      // and the user's just-sent message would arrive off-screen.
      scrollToBottom("smooth");
    },
  });

  const addImages = useCallback((files: File[]) => {
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // Claude API per-image limit
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    const oversized = imageFiles.find((f) => f.size > MAX_IMAGE_SIZE);
    if (oversized) {
      setUploadError(
        `Image too large (${(oversized.size / 1024 / 1024).toFixed(1)}MB). Maximum ${MAX_IMAGE_SIZE / 1024 / 1024}MB per image.`,
      );
      return;
    }

    const newImages: PendingImage[] = imageFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setPendingImages((prev) => [...prev, ...newImages]);
    setUploadError(null);
  }, []);

  const removeImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const handleSend = async () => {
    const text = draft.trim();
    const images = pendingImages;
    if (!text && images.length === 0) return;
    if (uploading) return;
    // Group-chat send guard: don't fire requests we know the server (with
    // proposal §3 enforcement) or downstream `mention_only` agents will drop.
    if (requiresMention && draftMentions.length === 0) return;

    // "Mention to invite": any `@<name>` pointing at an agent outside the
    // current chat is treated as both an address and an invitation. We add
    // them first so by the time the message is processed, the server's
    // `extractMentions` resolves successfully and direct-chats auto-upgrade
    // to groups via the server's `changeChatType` service. Idempotent on
    // the server.
    if (draftOutsiders.length > 0) {
      try {
        await addMeChatParticipants(chatId, { participantIds: draftOutsiders });
        await queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Failed to add participants");
        return;
      }
    }

    if (images.length > 0) {
      setUploading(true);
      setUploadError(null);
      try {
        // Track the latest server-returned message id across the
        // sequence of file POSTs (and the optional trailing text
        // POST) so we can pre-advance the high water in one shot
        // after the whole batch lands. See `pendingHighWaterAdvance`
        // for rationale.
        let lastSentMessageId: string | null = null;
        for (const img of images) {
          const data = await readFileAsBase64(img.file);
          const imageId = crypto.randomUUID();
          // Write to IndexedDB before the POST so the sending tab can render
          // its own message via the imageRef shape immediately on refetch,
          // even if the server write races ahead of the response.
          await putImage({ imageId, base64: data, mimeType: img.file.type });
          const fileMsg = await sendFileMessage(chatId, {
            data,
            mimeType: img.file.type,
            filename: img.file.name,
            size: img.file.size,
            imageId,
          });
          lastSentMessageId = fileMsg.id;
          URL.revokeObjectURL(img.previewUrl);
        }
        setPendingImages([]);
        if (text) {
          const textMsg = await sendChatMessage(chatId, text);
          lastSentMessageId = textMsg.id;
        }
        setDraft("");
        queryClient.invalidateQueries({ queryKey: ["chat-messages", chatId] });
        // Mirror sendMut.onSuccess: predictive session-activation only shows
        // up in the sidebar after we invalidate, otherwise the file-send path
        // for the first message in a new chat waits for 10s polling.
        queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(agentId) });
        // Pre-advance the high water before the smooth scroll for
        // the same reason as in sendMut.onSuccess — pill never
        // flashes for the user's own send. Also persist directly to
        // queryClient cache + IDB so the chat-switch-mid-send case
        // is durable (see sendMut.onSuccess for rationale).
        if (lastSentMessageId) {
          const ownSendReadState: ReadState = {
            chatId,
            bottomVisibleMessageId: lastSentMessageId,
            latestKnownMessageId: lastSentMessageId,
            updatedAt: Date.now(),
          };
          queryClient.setQueryData<ReadState>(["chat-read-state", chatId], ownSendReadState);
          void setReadState(chatId, lastSentMessageId, lastSentMessageId);
          setPendingHighWaterAdvance({ chatId, messageId: lastSentMessageId });
        }
        // Same scroll-on-send as sendMut.onSuccess — the file-send
        // path goes through a different code branch so we have to
        // repeat the call here.
        scrollToBottom("smooth");
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Failed to send image");
      } finally {
        setUploading(false);
      }
      return;
    }

    sendMut.mutate(text);
  };

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);
  const renameMut = useMutation({
    mutationFn: (topic: string | null) => renameChat(chatId, topic),
    onSuccess: () => {
      setRenaming(false);
      queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
      queryClient.invalidateQueries({ queryKey: ["agent-sessions", agentId] });
      queryClient.invalidateQueries({ queryKey: ["session", agentId, chatId] });
    },
  });
  const commitRename = () => {
    const trimmed = renameDraft.trim();
    renameMut.mutate(trimmed.length > 0 ? trimmed : null);
  };

  /**
   * Timeline composition: messages (real chat rows, including the forwarded
   * final result) are always visible; transient events go through the
   * turn-grouping filter so completed turns collapse to just their result
   * message. See `filterEventsForTimeline` for the full rules.
   */
  // Merge cached + server messages, dedup by id (server wins so updated
  // delivery status / metadata overrides any older cached copy), and
  // sort by createdAt. This is the union the timeline renders from.
  const mergedMessages = useMemo<MessageWithDelivery[]>(() => {
    const fromCache = cachedMessages ?? [];
    const fromServer = messagesData?.items ?? [];
    const byId = new Map<string, MessageWithDelivery>();
    for (const m of fromCache) byId.set(m.id, m);
    for (const m of fromServer) byId.set(m.id, m);
    return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [cachedMessages, messagesData]);

  // Detect a known gap between the cache range and the server's "last 50"
  // window: if there's no overlap and the server's oldest fetched message
  // is strictly newer than the cache's newest, the user was away long
  // enough that more than 50 messages went past in between, and we have
  // no way to fill them in until cursor pagination ships. Render a banner
  // after the message id returned here. Returns null when there's overlap
  // (the common case) or when either side is empty.
  const gapAfterMessageId = useMemo<string | null>(() => {
    const fromCache = cachedMessages ?? [];
    const fromServer = messagesData?.items ?? [];
    const firstCached = fromCache[0];
    const firstServer = fromServer[0];
    if (!firstCached || !firstServer) return null;
    const serverIds = new Set(fromServer.map((m) => m.id));
    for (const cached of fromCache) {
      if (serverIds.has(cached.id)) return null;
    }
    let newestCached = firstCached;
    for (const m of fromCache) {
      if (m.createdAt > newestCached.createdAt) newestCached = m;
    }
    let oldestServer = firstServer;
    for (const m of fromServer) {
      if (m.createdAt < oldestServer.createdAt) oldestServer = m;
    }
    if (oldestServer.createdAt <= newestCached.createdAt) return null;
    return newestCached.id;
  }, [cachedMessages, messagesData]);

  const items: TimelineItem[] = useMemo(() => {
    const visibleEvents = filterEventsForTimeline(eventsData?.items ?? []);

    const out: TimelineItem[] = [
      ...mergedMessages.map((m) => ({ kind: "message" as const, at: m.createdAt, key: `m-${m.id}`, data: m })),
      ...visibleEvents.map((e) => ({ kind: "event" as const, at: e.createdAt, key: `e-${e.id}`, data: e })),
    ];
    out.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }, [mergedMessages, eventsData]);

  /**
   * For every `format=question` message we render, we need the matching
   * `question_answer` (when one has landed). Build a (correlationId →
   * answer-content) lookup once per messages refresh — there's no separate
   * pending-status endpoint yet, so the presence of the answer message is
   * the canonical "answered" signal. v1 collapses superseded into pending
   * since we don't have a WS-pushed supersede signal yet (commit 6).
   */
  // Build the lookup from mergedMessages (cache ∪ server), not just
  // messagesData. Otherwise a cached question_answer that has aged out of
  // the server's "last 50" window would be invisible to this lookup —
  // its matching question would render as `pending` even though the
  // answer is right there in the timeline (cached). Caught in PR 286
  // review by Codex / yuezengwu.
  const answersByCorrelationId = useMemo(() => {
    const map = new Map<string, QuestionAnswerMessageContent>();
    for (const m of mergedMessages) {
      if (m.format !== "question_answer") continue;
      if (isQuestionAnswerContent(m.content)) {
        map.set(m.content.correlationId, m.content);
      }
    }
    return map;
  }, [mergedMessages]);

  const itemCount = items.length;

  // M2: scroll-position snapshot — synchronous IndexedDB lookup of
  // where the user's viewport bottom was the last time they left
  // this chat. React Query's cache holds it after first read so a
  // chat re-open does not block on IDB.
  const { data: readState } = useQuery({
    queryKey: ["chat-read-state", chatId],
    queryFn: () => getReadState(chatId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const storedBottomVisibleId = readState?.bottomVisibleMessageId ?? null;

  // Resolve the stored bottom-visible id against the rendered set
  // so we can decide where to scroll on chat open. If the stored
  // id is gone (deleted message, or not in the current window),
  // we fall back to first-time-open semantics.
  const bottomVisibleResolution = useMemo<{ anchorId: string; index: number } | null>(() => {
    if (!storedBottomVisibleId || mergedMessages.length === 0) return null;
    const exact = mergedMessages.findIndex((m) => m.id === storedBottomVisibleId);
    if (exact >= 0) {
      const exactMsg = mergedMessages[exact];
      if (exactMsg) return { anchorId: exactMsg.id, index: exact };
    }
    return null;
  }, [storedBottomVisibleId, mergedMessages]);

  // Frozen-at-open snapshot of `readState.latestKnownMessageId` —
  // the chat tip the user left this chat at on the previous visit.
  // Drives BOTH the "New Messages" divider and the "↓ N new messages"
  // pill: the boundary between already-seen-before-leaving and
  // arrived-since-then.
  //
  // Why frozen: as the user scrolls, the in-session read tracker
  // writes fresh `latestKnownMessageId` values back into the IDB
  // row (and the React Query cache), advancing the LIVE
  // `readState.latestKnownMessageId` to the current DOM tip. If
  // either the divider or the pill read from that live value, the
  // anchor would slide forward during the visit — the divider
  // would not render and the pill would never reach a non-zero
  // count. Both must use this snapshot instead.
  //
  // History: PR 286 manual sign-off rev 8 — code-reviewer reproduced
  // "pill never shows on return-to-chat-with-injected-messages" and
  // root-caused it to the live readState read in the pill baseline.
  const [dividerAnchorMessageId, setDividerAnchorMessageId] = useState<string | null>(null);
  // Dismiss when the divider has scrolled out the top of the
  // viewport (IntersectionObserver below). Kept as state so the
  // render path can drop the divider once dismissed. Reset on chat
  // switch.
  const [dividerDismissed, setDividerDismissed] = useState<boolean>(false);
  // Tracks which chatId we have already snapshotted the divider
  // anchor for. Without this guard, the snapshot would re-fire on
  // every tracker IDB write (each one updates the React Query
  // cache for the chat-read-state key) and the anchor would slide
  // forward — defeating the "frozen at open" intent.
  const dividerSnapshotChatIdRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the trigger; setters are stable.
  useLayoutEffect(() => {
    setDividerAnchorMessageId(null);
    setDividerDismissed(false);
    dividerSnapshotChatIdRef.current = null;
  }, [chatId]);
  // Snapshot once the read-state query for this chatId has resolved
  // (data is `undefined` while loading, `null` for no row, and a
  // `ReadState` otherwise). Skips when there is no prior IDB row —
  // first-time visits intentionally show no divider.
  useEffect(() => {
    if (dividerSnapshotChatIdRef.current === chatId) return;
    if (readState === undefined) return;
    dividerSnapshotChatIdRef.current = chatId;
    setDividerAnchorMessageId(readState?.latestKnownMessageId ?? null);
  }, [chatId, readState]);

  // Index of the snapshotted anchor in the current `mergedMessages`.
  // -1 when there is no anchor (first-time visit or while readState
  // is still loading) or when the anchor has aged out of the
  // server window. Used as the boundary for BOTH the divider
  // position and the pill's "new since last visit" baseline — the
  // canonical "everything up to here was already on screen when the
  // user last left" pointer.
  //
  // Index-based (not lex on message id) because `crypto.randomUUID()`
  // in `server/src/services/message.ts:188` produces UUID v4, which
  // is NOT time-sortable. A v4 id for a brand-new message can lex
  // compare LESS than an older anchor's id and silently get
  // classified as "already seen". `mergedMessages` is already sorted
  // by `createdAt` ascending, so the index is the right ordering.
  const unreadAnchorIdx = useMemo<number>(() => {
    if (!dividerAnchorMessageId) return -1;
    return mergedMessages.findIndex((m) => m.id === dividerAnchorMessageId);
  }, [dividerAnchorMessageId, mergedMessages]);

  // Live bottom-visible id during the current session. Driven by
  // useReadTracker's `onBottomVisibleChange` callback. Used as the
  // signal that advances the session high watermark below.
  const [liveBottomVisibleId, setLiveBottomVisibleId] = useState<string | null>(null);

  // Session high watermark — id of the latest message the user has
  // reached (had at viewport bottom) at any point during the
  // current chat session. Stored as a MESSAGE ID, not an index,
  // because indices into `mergedMessages` are not stable across
  // (a) polled window shifts (server may slide the visible window
  // forward as new messages arrive — old indices then point to
  // different messages) and (b) `scrollIntoView` boundary quirks.
  // An id is content-addressed and resolves to the correct row
  // regardless of how the underlying list moves.
  //
  // Monotonic forward semantics: we only set this to a new id if
  // that id is chronologically later than the current one (resolved
  // via `findIndex` at advance time). Scrolling back UP after
  // reaching a high water leaves the id unchanged.
  //
  // Combined with the frozen-at-open anchor index (`unreadAnchorIdx`,
  // derived from the snapshotted `dividerAnchorMessageId`), this is
  // the "everything up to here is known to the user" pointer that
  // drives the pill count.
  //
  // History: the previous implementation stored an integer
  // `sessionHighestRaw` and caused the pill-never-shows bug
  // liuchao-001 reported — when poll-driven window shift moved old
  // messages off the top, `sessionHighestRaw=49` ended up pointing
  // at a brand-new message the user had never seen, suppressing
  // the pill. PR 286 manual sign-off rev 7 (code-reviewer's repro).
  const [sessionHighestId, setSessionHighestId] = useState<string | null>(null);
  // Reset the in-session watermark (and the live bottom-visible
  // mirror) on every chat switch.
  //
  // useLayoutEffect (not useEffect): runs synchronously after DOM
  // commit but before paint, and the `setState`s here trigger a
  // synchronous re-render before paint as well. Without this, on
  // A → B with B warm-cached the first paint of B would briefly
  // render with A's stale `sessionHighestId`. If A's high water id
  // resolved to an in-range index in B's list, that paint would
  // show a false "↓ N new messages" pill for a fraction of a
  // second before useEffect cleared it. useLayoutEffect closes
  // the window — the user never sees the stale state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the trigger; setters are stable.
  useLayoutEffect(() => {
    setSessionHighestId(null);
    setLiveBottomVisibleId(null);
    // Drop any pending own-send pre-advance from the previous
    // chat — the new chat's watermark should not inherit the
    // outgoing chat's last sent message.
    setPendingHighWaterAdvance(null);
  }, [chatId]);
  // Drain `pendingHighWaterAdvance` into `sessionHighestId`. Lives
  // here (not directly inside `sendMut.onSuccess` / the file-send
  // path) because `setSessionHighestId` is declared in this block —
  // a useEffect lets the setter signal flow forward without a
  // forward reference. The `chatId` check protects against the
  // race where a send's response arrives AFTER the user has
  // switched to a different chat.
  useEffect(() => {
    if (!pendingHighWaterAdvance) return;
    if (pendingHighWaterAdvance.chatId !== chatId) {
      setPendingHighWaterAdvance(null);
      return;
    }
    setSessionHighestId(pendingHighWaterAdvance.messageId);
    setPendingHighWaterAdvance(null);
  }, [pendingHighWaterAdvance, chatId]);
  // Advance the watermark id whenever the user's viewport bottom
  // reaches a message later than the previous high water.
  // Comparison goes through current `mergedMessages` so both ids
  // are resolved against the live ordering — invariant to window
  // shifts.
  //
  // Regression guard: if `sessionHighestId` is set but currently
  // unresolvable in `mergedMessages` (i.e., the id doesn't appear
  // in the rendered list yet), bail without advancing. This covers
  // two cases:
  //   1. Pre-advance: `sendMut.onSuccess` just set `sessionHighestId`
  //      to the brand-new server-returned id, but the cache
  //      invalidation+refetch hasn't landed yet, so the new msg
  //      isn't in `mergedMessages`. Without this guard the advance
  //      effect would observe the OLD last-visible id and overwrite
  //      the pre-advance, re-opening the own-send flash window.
  //   2. Window-shift drop-off: a previously valid high-water id
  //      that has fallen out of the polling window. In that case
  //      "the user has already seen everything older than the
  //      current window" is the conservative interpretation, but
  //      regressing to the new bottom-visible would be wrong — wait
  //      until the next forward advance instead.
  useEffect(() => {
    if (!liveBottomVisibleId) return;
    const newIdx = mergedMessages.findIndex((m) => m.id === liveBottomVisibleId);
    if (newIdx < 0) return;
    if (sessionHighestId !== null) {
      const curIdx = mergedMessages.findIndex((m) => m.id === sessionHighestId);
      if (curIdx < 0) return;
      if (newIdx <= curIdx) return;
    }
    setSessionHighestId(liveBottomVisibleId);
  }, [liveBottomVisibleId, mergedMessages, sessionHighestId]);
  // Effective high water index, resolved from `sessionHighestId`
  // against the live `mergedMessages`. Max with the frozen-at-open
  // anchor index covers the re-visit-without-scroll path (no
  // in-session advance, but the prior-visit high water still
  // applies). The baseline MUST come from the frozen anchor —
  // reading the live `readState.latestKnownMessageId` here is the
  // bug code-reviewer caught in rev 8: the tracker's debounced
  // write at ~600ms after chat-open advances the live value to the
  // current DOM tip, which would lift this baseline above every
  // newly-injected message and suppress the pill.
  const sessionHighestIdx = useMemo<number>(() => {
    const sessionIdx = sessionHighestId ? mergedMessages.findIndex((m) => m.id === sessionHighestId) : -1;
    return Math.max(sessionIdx, unreadAnchorIdx);
  }, [sessionHighestId, mergedMessages, unreadAnchorIdx]);

  // Pill count = messages strictly newer than the effective high
  // watermark. Hides (count = 0) whenever the user has had every
  // currently-rendered message at viewport bottom at some point
  // (either this session or a prior one persisted in IDB).
  const pillCount = useMemo<number>(() => {
    if (mergedMessages.length === 0) return 0;
    if (sessionHighestIdx < 0) return 0;
    return Math.max(0, mergedMessages.length - 1 - sessionHighestIdx);
  }, [mergedMessages, sessionHighestIdx]);

  // Index of the first message strictly newer than the snapshotted
  // anchor — i.e., where the "New Messages" line slots in.
  //
  // Comparison is by index in `mergedMessages` (which is sorted by
  // `createdAt` ascending). DO NOT compare by lex order on the
  // message id: `server/src/services/message.ts:188` generates ids
  // with `crypto.randomUUID()` (UUID v4, random), so id ordering
  // does not match time ordering. An earlier version used `id > anchor`
  // and silently dropped the divider whenever the freshly-injected
  // message's id happened to sort lexicographically below the
  // anchor's — the bug code-reviewer reproduced in rev 8.
  //
  // Returns -1 when the divider should not render (no anchor, anchor
  // has aged out of the window, or no newer messages).
  const firstNewItemIdx = useMemo<number>(() => {
    if (unreadAnchorIdx < 0) return -1;
    const idxById = new Map<string, number>();
    for (let i = 0; i < mergedMessages.length; i++) {
      const msg = mergedMessages[i];
      if (msg) idxById.set(msg.id, i);
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.kind !== "message") continue;
      const idx = idxById.get(item.data.id);
      if (idx !== undefined && idx > unreadAnchorIdx) return i;
    }
    return -1;
  }, [items, mergedMessages, unreadAnchorIdx]);

  // Hide the divider the moment it scrolls past the top of the
  // viewport — but keep it visible while the user is still looking
  // at it, even after they have read every new message below.
  // Dismissal is one-way during a visit; the next chat open
  // re-evaluates from the fresh snapshot.
  const dividerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (dividerDismissed) return;
    if (firstNewItemIdx < 0) return;
    const node = dividerRef.current;
    const container = scrollContainerRef.current;
    if (!node || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const rootBounds = entry.rootBounds;
          if (!rootBounds) continue;
          if (entry.boundingClientRect.bottom < rootBounds.top) {
            setDividerDismissed(true);
            return;
          }
        }
      },
      { root: container, threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [firstNewItemIdx, dividerDismissed]);

  // Decide where to land on chat open. Fires exactly once per chat-
  // id visit, the first moment the timeline has items to scroll
  // within — so a hard-reload that loads chatId before queries
  // hydrate still lands correctly when items arrive.
  //
  // Gated by `landedForChatRef`. Subsequent itemCount changes
  // (poll-driven append) are bailed; new-message handling falls to
  // the pill instead.
  //
  // useLayoutEffect (not useEffect): fires synchronously after DOM
  // commit but before paint, so the first frame the user sees is
  // already at the right scroll position.
  //
  // Earlier rounds:
  //  - PR 286 review M1 round → answersByCorrelationId source fix.
  //  - PR 286 review M2 round → Bug 1 (hard reload landed at top
  //    because deps were `[chatId]` only and bailed on itemCount=0).
  //  - liuchao-001 manual sign-off → top-then-bottom flash (fixed
  //    by switching to useLayoutEffect + *Immediate variants).
  //  - liuchao-001 manual sign-off → model swap from monotonic
  //    "last-read marker" to "bottom-visible-on-leave snapshot",
  //    so coming back to a chat lands you where you were visually,
  //    not at "the bottom of all content I've ever seen here".
  const landedForChatRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (itemCount === 0) return;
    if (landedForChatRef.current === chatId) return;
    landedForChatRef.current = chatId;
    if (bottomVisibleResolution) {
      // Land the stored anchor at the viewport bottom. Any messages
      // newer than the anchor sit below the fold; the pill will
      // surface them.
      scrollToMessageImmediate(bottomVisibleResolution.anchorId, "end", "auto");
    } else {
      // No prior snapshot (first-time visit, or the stored anchor
      // is gone): preserve the M1-era "open scrolls to bottom"
      // behavior.
      scrollToBottomImmediate("auto");
    }
  }, [chatId, itemCount, bottomVisibleResolution, scrollToMessageImmediate, scrollToBottomImmediate]);

  // Watches the scroll position and persists the bottom-visible
  // message id per chat. Distinct from the prior monotonic-marker
  // model — the snapshot reflects where the viewport bottom WAS,
  // not what the user has read.
  //
  // `onWrite` mirrors every IDB write into React Query's cache for
  // the `["chat-read-state", chatId]` key, so a same-session re-visit
  // (A → B → A) picks up the latest snapshot even though the query
  // has `staleTime: Infinity`.
  //
  // `onBottomVisibleChange` publishes the live value so the pill
  // can recompute its count on every scroll event without an IDB
  // round-trip.
  useReadTracker({
    containerRef: scrollContainerRef,
    messages: mergedMessages,
    chatId,
    onWrite: (cid, bottomVisibleMessageId, latestKnownMessageId) => {
      queryClient.setQueryData<ReadState>(["chat-read-state", cid], {
        chatId: cid,
        bottomVisibleMessageId,
        latestKnownMessageId,
        updatedAt: Date.now(),
      });
    },
    onBottomVisibleChange: setLiveBottomVisibleId,
  });

  // Pill click: jump to the bottom. As the scroll lands, the
  // tracker's scroll listener picks up the new bottom-visible id
  // (the latest message), pillCount zeroes out, and the pill
  // unmounts. No need to manually clear state.
  const onPillClick = useCallback(() => {
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  // Thought-stream auto-follow. When the agent is actively
  // working, its session_events (assistant_text / tool_call /
  // thinking) arrive incrementally via 5s polling and render as
  // "streaming" rows in the timeline. M1 followed every itemCount
  // change to the bottom, which kept the viewport tracking the
  // stream. M2's once-per-visit gate eliminated that, leaving the
  // stream piling up off-screen for at-bottom users.
  //
  // Restore the behavior, narrowly: when items grow due to
  // *events only* (not new messages) AND the user is at the
  // bottom, smooth-scroll to follow. Final-message arrivals are
  // still NOT followed — they surface via the pill, per the user
  // spec ("agent's chunky reply shouldn't yank scroll, but the
  // streaming thought process should").
  //
  // Once issue 130 lands WebSocket push for session_events, this
  // path will fire at sub-second granularity instead of every 5s,
  // and the same follow logic stays correct.
  //
  // Caught in PR 286 manual sign-off rev 3 — the prior M2 silently
  // broke this behavior, the user flagged it.
  const prevCountsRef = useRef<{ chatId: string; itemCount: number; messagesCount: number }>({
    chatId: "",
    itemCount: 0,
    messagesCount: 0,
  });
  useEffect(() => {
    const prev = prevCountsRef.current;
    if (prev.chatId !== chatId) {
      // Chat switched — establish a fresh baseline, no follow.
      prevCountsRef.current = { chatId, itemCount, messagesCount: mergedMessages.length };
      return;
    }
    const itemsGrew = itemCount > prev.itemCount;
    const messagesGrew = mergedMessages.length > prev.messagesCount;
    if (itemsGrew && !messagesGrew && isAtBottom) {
      // Growth is event-only (a streaming thought / tool call /
      // assistant_text row appeared); the user is currently at
      // the bottom, so pull them along with the stream.
      scrollToBottom("smooth");
    }
    prevCountsRef.current = { chatId, itemCount, messagesCount: mergedMessages.length };
  }, [chatId, itemCount, mergedMessages.length, isAtBottom, scrollToBottom]);

  const displayName = agentName(agentId);

  /** Set of agentIds currently in the chat. Used to (a) detect "outsiders"
   *  the user `@`-mentions and (b) skip the redundant addParticipants call
   *  when everyone they mention is already in the room. */
  const chatParticipantIds = useMemo(() => {
    return new Set(chatDetail?.participants?.map((p) => p.agentId) ?? []);
  }, [chatDetail?.participants]);

  // Mention autocomplete candidates: every org agent the user might address,
  // resolved to their `{name, displayName}` via the shared identity map.
  // Includes BOTH chat participants and outsiders — picking an outsider
  // implicitly invites them via `addMeChatParticipants` at send time, which
  // turns a 1:1 into a group server-side. Self is excluded; any agent
  // without a slug (`name`) is skipped because mentions need one — even
  // current chat participants. This is intentional: the server's
  // `extractMentions` matches `@<token>` against `agents.name`, so a
  // participant with `name=null` (legacy / soft-deleted row) cannot be
  // addressed via `@` regardless. They still show in `ParticipantsHeader`
  // chips (which uses `agentIdentity.displayName`); the picker just won't
  // offer them. Fixing this requires the server to backfill missing
  // `agents.name`, not a client-side workaround.
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const ids = new Set<string>();
    for (const p of chatDetail?.participants ?? []) ids.add(p.agentId);
    for (const a of activity?.agents ?? []) ids.add(a.agentId);
    if (ids.size === 0) ids.add(agentId);
    // Build a lookup from `/activity` so we can attach `managedByMe`
    // per candidate. Known limitation: agents that appear only via
    // `chatDetail.participants` (no runtime presence row, e.g. an
    // autonomous agent that has never been bound to a client) default
    // to false. That means a caller's own offline agent can be
    // misclassified into the "teammates" group of the [+] picker.
    // The picker grouping is a visual hint, not a security boundary,
    // so we accept this fidelity loss rather than widen `/activity`'s
    // shape (which is also consumed by roster / team / clients pages).
    // To revisit: surface `managedByMe` independently of runtime via a
    // dedicated `/me/managed-agents` endpoint and intersect here.
    const managedByMeMap = new Map<string, boolean>();
    for (const a of activity?.agents ?? []) managedByMeMap.set(a.agentId, a.managedByMe);
    const out: MentionCandidate[] = [];
    for (const id of ids) {
      if (id === myAgentId) continue;
      const ident = agentIdentity(id);
      if (!ident || !ident.name) continue;
      out.push({
        agentId: id,
        name: ident.name,
        displayName: ident.displayName,
        managedByMe: managedByMeMap.get(id) ?? false,
      });
    }
    return out;
  }, [chatDetail?.participants, activity?.agents, agentId, agentIdentity, myAgentId]);

  /**
   * "Needs explicit @mention" guard: a real group, OR a direct chat where the
   * current user isn't yet a participant (their first send promotes it to a
   * 3-person group). In both cases an unaddressed message would be silently
   * dropped by `mention_only` peers and the server now rejects it with 400.
   * See proposals/group-chat-ux-improvements §2.
   */
  const requiresMention = useMemo(() => {
    if (!chatDetail) return false;
    if (chatDetail.type === "group") return true;
    const meIn = chatDetail.participants.some((p) => p.agentId === myAgentId);
    return chatDetail.type === "direct" && !meIn && chatDetail.participants.length >= 2;
  }, [chatDetail, myAgentId]);

  // First-message pre-fill: when the user lands on a brand-new empty chat
  // (typical right after onboarding's "Create" succeeds), drop a friendly
  // "Hi {name}!" into the input so hitting Enter is enough. Group chats are
  // skipped — the focus auto-prime there stamps "@" to pick a recipient,
  // which would conflict with this. Once pre-filled, the chatId is added
  // to a Set so re-entering the same empty chat later (user navigated away
  // before sending) doesn't slap the greeting back over their cleared draft.
  // Gated on `chatDetail` being loaded too, otherwise `requiresMention`
  // would still be its default `false` while messages/events have arrived,
  // and we'd stamp a plain greeting into a group/about-to-be-group chat
  // that actually needs an `@` recipient. Also gated on `displayName !==
  // agentId` — the name map's fallback is the raw UUID, so an unresolved
  // name would otherwise stamp "Hi <uuid>! …" and the Set guard prevents
  // a fix-up once the map loads. We just wait for it.
  useEffect(() => {
    // Watchers don't see the composer; stamping a greeting into `draft`
    // is invisible at best and at worst contaminates `prefilledChatsRef`
    // so that joining-then-typing skips the greeting on the next mount.
    if (readOnly) return;
    if (prefilledChatsRef.current.has(chatId)) return;
    if (!messagesData || !eventsData || !chatDetail) return;
    if (items.length > 0) return;
    if (draft.length > 0) return;
    if (requiresMention) return;
    if (displayName === agentId) return;
    const greeting = `Hi ${displayName}! What can you help with?`;
    setDraft(greeting);
    setCursor(greeting.length);
    prefilledChatsRef.current.add(chatId);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(greeting.length, greeting.length);
    });
  }, [
    chatId,
    agentId,
    messagesData,
    eventsData,
    chatDetail,
    items.length,
    draft.length,
    displayName,
    requiresMention,
    readOnly,
  ]);

  /** All agentIds the draft text addresses via `@<name>` tokens — computed
   * unconditionally (not just for groups) so the "outsider invite" path
   * below can detect mentions of agents not yet in the chat. The send-gate
   * for groups still uses `requiresMention && draftMentions.length === 0`. */
  const draftMentions = useMemo(() => {
    const ps: MentionParticipant[] = mentionCandidates.map((c) => ({ agentId: c.agentId, name: c.name }));
    return extractMentions(draft, ps);
  }, [draft, mentionCandidates]);

  /** Mentions in the draft that point at agents NOT currently in the chat.
   * Sending a message that addresses these will first POST to
   * `/me/chats/:id/participants` to add them, which turns a direct chat
   * into a group via the server's `changeChatType` service. */
  const draftOutsiders = useMemo(() => {
    if (chatParticipantIds.size === 0) return [];
    return draftMentions.filter((id) => !chatParticipantIds.has(id));
  }, [draftMentions, chatParticipantIds]);

  const mention = useMentionAutocomplete({
    value: draft,
    cursor,
    candidates: mentionCandidates,
    disabled: sendMut.isPending || uploading,
    onSelect: (update) => {
      setDraft(update.text);
      setCursor(update.cursor);
      // Defer so React has committed the new value before we move the
      // selection — otherwise the textarea snaps back to its old cursor.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(update.cursor, update.cursor);
      });
    },
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Chat header. Spans the full panel width with generous side
          breathing (sp-10) so it reads as the panel's "context bar".
          Title + participants column anchors to the left; the right
          edge is intentionally empty after the SessionControls
          (Suspend/Terminate) removal — those were dev/runtime concerns
          that don't belong in the chat-first user surface. Future
          chat-level actions (mute, archive, leave) will land here in
          an overflow menu. */}
      <div
        className="shrink-0"
        style={{
          padding: "var(--sp-2_5) var(--sp-6)",
          borderBottom: "var(--hairline) solid var(--border)",
        }}
      >
        {/* Header content sits in the same centered reading column as
            the timeline + composer below — title's left edge aligns
            with message avatars, chips' right edge aligns with the
            composer's right edge. The outer band still bleeds to the
            panel edges (border-bottom + side padding) so the header
            keeps its frame role; only the content centers. */}
        <div
          className="flex items-center"
          style={{
            maxWidth: "clamp(55rem, 75%, 70rem)",
            margin: "0 auto",
            width: "100%",
            gap: 10,
          }}
        >
          {/* Identity — title is the sole click-to-rename affordance
              (Slack / Linear pattern). The hover-only ✏️ pencil was
              dropped after the title itself became clickable: two
              affordances for the same action add visual noise without
              improving discoverability. The per-agent `StateDot` was
              also dropped — in chat-first, runtime is a per-agent
              concept that belongs on each chip avatar (D-4), not on
              the chat header. */}
          <div className="flex items-center min-w-0" style={{ gap: 8, flex: 1 }}>
            {readOnly ? (
              <>
                <span className="truncate text-subtitle min-w-0" style={{ color: "var(--fg)" }}>
                  {chatDetail?.title ?? titleFallback ?? "…"}
                </span>
                <span
                  className="mono uppercase text-eyebrow shrink-0"
                  style={{
                    padding: "var(--hairline) var(--sp-1_25)",
                    borderRadius: 2,
                    color: "var(--fg-3)",
                    background: "var(--bg-sunken)",
                  }}
                >
                  watching
                </span>
              </>
            ) : renaming ? (
              <>
                <input
                  ref={renameInputRef}
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setRenaming(false);
                    }
                  }}
                  disabled={renameMut.isPending}
                  maxLength={500}
                  // Placeholder echoes the rendered title (auto-generated
                  // from the first message when no topic is set). This
                  // signals "leave blank to keep the current name" without
                  // pre-filling the input with the auto-title — a pre-fill
                  // would make a no-op commit silently promote the auto-
                  // title to a sticky `topic`, locking it against future
                  // first-message edits.
                  placeholder={chatDetail?.title ?? "Chat name"}
                  className="outline-none text-subtitle"
                  // Auto-grow with content (modern CSS `field-sizing: content`)
                  // so the ✓/× buttons sit immediately after the last typed
                  // character instead of floating at the panel's right edge.
                  // `minWidth` keeps the input usable from an empty draft;
                  // `maxWidth` prevents it from pushing chips off-screen on
                  // very long input. Browsers without `field-sizing` support
                  // (older Safari/Firefox) fall back to a sensible default
                  // sized by the input element's intrinsic width.
                  style={{
                    fieldSizing: "content",
                    minWidth: 200,
                    maxWidth: 480,
                    color: "var(--fg)",
                    background: "var(--bg-sunken)",
                    border: "var(--hairline) solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    padding: "var(--sp-0_5) var(--sp-1_5)",
                  }}
                />
                <button
                  type="button"
                  onClick={commitRename}
                  disabled={renameMut.isPending}
                  title="Save"
                  className="inline-flex items-center"
                  style={{ color: "var(--accent)", padding: 2 }}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming(false)}
                  disabled={renameMut.isPending}
                  title="Cancel"
                  className="inline-flex items-center"
                  style={{ color: "var(--fg-3)", padding: 2 }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  // Pre-fill with `topic` only (the existing manual
                  // override). When `topic` is null, leave the input
                  // empty so the auto-title shown as placeholder
                  // signals "type to override, leave blank to keep
                  // tracking the first message". A no-op commit thus
                  // sends `null` to the server (clearing topic = stay
                  // in auto-title mode), not the auto-title string —
                  // which would have locked the title against future
                  // first-message edits.
                  setRenameDraft(chatDetail?.topic ?? "");
                  setRenaming(true);
                }}
                title="Click to rename"
                className="truncate text-subtitle text-left min-w-0"
                style={{
                  color: "var(--fg)",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                {chatDetail?.title ?? "…"}
              </button>
            )}
            <EntityLink metadata={chatDetail?.metadata} />
          </div>
          {/* Audience — chips + add button. Right-anchored. Includes
              the viewer's own agent: in chat-first the user is a real
              participant and seeing themselves in the audience makes
              the membership state explicit. Self's display name comes
              through `agentIdentity` rather than `mentionCandidates`
              (the latter excludes self by design — you don't @ yourself).
              The [+] dropdown anchors to the right edge of the button
              so it grows leftward, avoiding panel-edge overflow when
              the chip row is long. */}
          <ParticipantsHeader
            chatId={chatId}
            participantIds={chatDetail?.participants?.map((p) => p.agentId) ?? [agentId]}
            candidates={mentionCandidates}
            agentIdentity={agentIdentity}
            onAdded={() => queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] })}
            readOnly={readOnly}
          />
        </div>
      </div>

      {/* Timeline region. Outer `relative flex-col` wrapper exists
          solely as the containing block for the floating pill —
          putting `position: relative` on the scroll container itself
          let the pill drift mid-list in some browsers (PR 286 manual
          sign-off rev 8). The wrapper sizes to the same bounds as
          the scroll viewport (single `flex-1` child + own `min-h-0`),
          so `absolute; bottom: var(--sp-3)` lands at the visible
          bottom of the chat panel regardless of scroll position.

          Scroll viewport stays full-width so the scrollbar hugs the
          panel's right edge — pushing it inward would float the
          column. Reading column inside is capped via `maxWidth` and
          centered to align with the composer below into one vertical
          thread. Side padding (sp-6) prevents content from kissing
          the panel border on narrow viewports. */}
      <div className="relative flex-1 flex flex-col min-h-0">
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto"
          style={{ padding: "var(--sp-2_5) var(--sp-6)" }}
        >
          <div style={{ maxWidth: "clamp(55rem, 75%, 70rem)", margin: "0 auto", width: "100%" }}>
            {itemCount === 0 && (
              <div
                className="flex flex-col items-center text-body"
                style={{ color: "var(--fg-3)", padding: "var(--sp-8) 0", gap: 6 }}
              >
                <MessageSquare className="h-8 w-8" style={{ opacity: 0.3 }} />
                {readOnly ? "No messages yet" : "Send a message to start the conversation"}
              </div>
            )}
            <div className="flex flex-col" style={{ gap: 4 }}>
              {items.flatMap((item, idx) => {
                let node: ReactNode = null;
                if (item.kind === "event") {
                  const ev = item.data;
                  switch (ev.kind) {
                    case "tool_call":
                      node = <ToolCallStatusRow key={item.key} event={ev} />;
                      break;
                    case "assistant_text":
                      node = <AssistantTextRow key={item.key} event={ev} agentId={agentId} agentNameFn={agentName} />;
                      break;
                    case "thinking":
                      node = <ThinkingRow key={item.key} event={ev} />;
                      break;
                    case "error":
                      node = <ErrorRow key={item.key} event={ev} />;
                      break;
                    default:
                      // turn_end is filtered upstream; any unknown kind is dropped.
                      node = null;
                  }
                } else {
                  const msg = item.data;
                  if (msg.format === "question" && isQuestionContent(msg.content)) {
                    const answer = answersByCorrelationId.get(msg.content.correlationId) ?? null;
                    const status: QuestionStatus = answer ? "answered" : "pending";
                    node = (
                      <QuestionMessageRow
                        key={item.key}
                        msg={msg}
                        chatId={chatId}
                        content={msg.content}
                        answer={answer}
                        status={status}
                        agentNameFn={agentName}
                      />
                    );
                  } else if (msg.format === "question_answer") {
                    node = <QuestionAnswerRow key={item.key} msg={msg} agentNameFn={agentName} />;
                  } else {
                    node = <TextRow key={item.key} msg={msg} myAgentId={myAgentId} agentNameFn={agentName} />;
                  }
                }
                // Insert the gap banner immediately after the last cached
                // message when there's a known break between cache and the
                // server window.
                const isGapAnchor = item.kind === "message" && item.data.id === gapAfterMessageId;
                // Insert the "New Messages" divider before the first item
                // whose message id is strictly newer than the snapshot
                // taken at chat-open. Dismissed once it has scrolled past
                // the top of the viewport (IntersectionObserver above).
                const showDivider = !dividerDismissed && idx === firstNewItemIdx;
                const prelude = showDivider ? <UnreadDivider key="unread-divider" ref={dividerRef} /> : null;
                const epilogue =
                  isGapAnchor && item.kind === "message" ? (
                    <HistoryGapBanner key={`gap-after-${item.data.id}`} />
                  ) : null;
                if (prelude || epilogue) {
                  const out: ReactNode[] = [];
                  if (prelude) out.push(prelude);
                  out.push(node);
                  if (epilogue) out.push(epilogue);
                  return out;
                }
                return node;
              })}
            </div>
            <div ref={messagesEndRef} />
          </div>
        </div>
        {/* Floating "↓ N new messages" pill — surfaces whenever
            there are messages newer than the user's session high
            watermark. Own sends never trigger the pill because
            `sendMut.onSuccess` / the file-send path pre-advance the
            watermark to the new message's id before initiating the
            smooth scroll, so `pillCount` stays 0 throughout the
            animation (PR 286 manual sign-off rev 10). Rendered as
            a sibling of the scroll container, not a child, so its
            `absolute` positioning anchors to the outer wrapper's
            visible bounds instead of being affected by the scroll
            container's internal `overflow-auto` + `position: relative`
            interaction (rev 8). */}
        {pillCount > 0 ? <NewMessagesPill count={pillCount} onClick={onPillClick} /> : null}
      </div>

      {/* Input. Outer band keeps full-width border-top + side padding so
          the composer separator continues the panel's edge-to-edge frame.
          Composer card inside is capped via `maxWidth` and centered, so it
          aligns vertically with the timeline column above — eye tracks
          from last message into textarea without a horizontal jump
          (Slack / ChatGPT / Linear DM all do this). */}
      <div
        className="shrink-0"
        style={{
          padding: "var(--sp-2_5) var(--sp-6) var(--sp-3)",
        }}
      >
        <div style={{ maxWidth: "clamp(55rem, 75%, 70rem)", margin: "0 auto", width: "100%" }}>
          {readOnly ? (
            <div
              className="flex items-center"
              style={{
                gap: "var(--sp-3)",
                padding: "var(--sp-2) var(--sp-3)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-sunken)",
              }}
            >
              <Eye className="h-4 w-4 shrink-0" style={{ color: "var(--fg-3)" }} />
              <div className="flex-1 min-w-0">
                <div className="text-body" style={{ color: "var(--fg-2)" }}>
                  You're watching this chat — read-only.
                </div>
                {joinAction?.error && (
                  <div className="mono text-label" style={{ color: "var(--state-error)", marginTop: 2 }}>
                    {joinAction.error}
                  </div>
                )}
              </div>
              {joinAction && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={joinAction.onJoin}
                  disabled={joinAction.joining}
                >
                  {joinAction.joining ? "Joining…" : "Join to reply"}
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for image upload */}
              <div
                style={{
                  position: "relative",
                  border: "var(--hairline) solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg-sunken)",
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addImages(Array.from(e.dataTransfer.files));
                }}
              >
                {/* Image preview area — above textarea */}
                {pendingImages.length > 0 && (
                  <div
                    className="flex items-center"
                    style={{ gap: 6, padding: "var(--sp-1_5) var(--sp-2_5) 0", overflowX: "auto" }}
                  >
                    {pendingImages.map((img) => (
                      <div
                        key={img.id}
                        style={{
                          position: "relative",
                          flexShrink: 0,
                          borderRadius: 4,
                          border: "var(--hairline) solid var(--border)",
                          overflow: "hidden",
                        }}
                      >
                        <img
                          src={img.previewUrl}
                          alt={img.file.name}
                          style={{ height: 32, width: "auto", display: "block", objectFit: "cover" }}
                        />
                        <button
                          type="button"
                          onClick={() => removeImage(img.id)}
                          style={{
                            position: "absolute",
                            top: 1,
                            right: 1,
                            width: 14,
                            height: 14,
                            borderRadius: "50%",
                            background: "var(--color-overlay-scrim)",
                            border: "none",
                            color: "var(--bg-raised)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          <X className="h-2 w-2" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ position: "relative" }}>
                  <MentionAutocompletePopover
                    trigger={mention.trigger}
                    results={mention.results}
                    highlightIndex={mention.highlightIndex}
                    anchorRef={textareaRef}
                    onPick={mention.pick}
                  />
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setCursor(e.target.selectionStart ?? e.target.value.length);
                    }}
                    onSelect={(e) => {
                      setCursor(e.currentTarget.selectionStart ?? draft.length);
                    }}
                    onFocus={() => {
                      // Group / about-to-be-group chats: prime the input with `@`
                      // on focus so the autocomplete pops the recipient list right
                      // away — matches the proposal §2 "must choose a receiver
                      // before typing" UX. Once-per-chat (focusPrimedRef): we
                      // don't want to re-stamp `@` after the user has cleared
                      // their draft and tabbed away/back; that would constantly
                      // fight the user when they're trying to write a fresh
                      // empty message without addressing anyone (e.g. paste over).
                      if (!requiresMention) return;
                      if (focusPrimedRef.current) return;
                      if (draft.length > 0 || mentionCandidates.length === 0) return;
                      focusPrimedRef.current = true;
                      setDraft("@");
                      setCursor(1);
                      requestAnimationFrame(() => {
                        const el = textareaRef.current;
                        if (!el) return;
                        el.setSelectionRange(1, 1);
                      });
                    }}
                    onPaste={(e) => {
                      const files = Array.from(e.clipboardData.files);
                      if (files.length > 0) {
                        e.preventDefault();
                        addImages(files);
                      }
                    }}
                    placeholder={
                      requiresMention
                        ? "Type @ to pick a recipient, then your message"
                        : `Message @${displayName}  ·  / for commands  ·  @ to mention`
                    }
                    rows={2}
                    onKeyDown={(e) => {
                      // Mention autocomplete gets first crack at navigation keys so
                      // ArrowUp/Down/Enter/Tab/Escape cycle candidates instead of
                      // sending or moving the cursor.
                      if (mention.handleKey(e)) return;
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    disabled={sendMut.isPending || uploading}
                    className="w-full outline-none text-subtitle font-normal"
                    style={{
                      padding: "var(--sp-2_25) var(--sp-3) var(--sp-7_5)",
                      background: "transparent",
                      border: "none",
                      // `rows={2}` alone won't survive the auto-resize hook:
                      // useLayoutEffect immediately sets `height = scrollHeight`,
                      // which collapses an empty textarea to ~1 line and
                      // breaks chat-view's pre-auto-grow 2-line contract.
                      // CSS `min-height` is a hard floor that wins over the
                      // hook's inline `height`, so we restate the 2-line
                      // starting size here: 2 line-heights + top + bottom
                      // padding. Cap at 10.5rem (~8 visible lines) so long
                      // pastes scroll inside instead of pushing the footer
                      // toolbar off-screen.
                      minHeight: "calc(2lh + var(--sp-2_25) + var(--sp-7_5))",
                      maxHeight: "10.5rem",
                      overflowY: "auto",
                      resize: "none",
                      color: "var(--fg)",
                    }}
                  />
                </div>
                <div
                  className="flex items-center justify-between text-caption"
                  style={{
                    position: "absolute",
                    bottom: 6,
                    left: 10,
                    right: 10,
                    color: "var(--fg-4)",
                  }}
                >
                  <span className="mono flex items-center" style={{ gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => {
                        // Insert `@` at the cursor (or replace the current selection)
                        // and re-focus. The mention autocomplete will pick it up
                        // from the resulting `value`/`cursor` state — same path as
                        // typing `@` directly. Mirrors the Feishu / Slack
                        // explicit-button affordance for users who don't know the
                        // keyboard trick.
                        const el = textareaRef.current;
                        if (!el) return;
                        const start = el.selectionStart ?? draft.length;
                        const end = el.selectionEnd ?? start;
                        const next = `${draft.slice(0, start)}@${draft.slice(end)}`;
                        setDraft(next);
                        setCursor(start + 1);
                        requestAnimationFrame(() => {
                          el.focus();
                          el.setSelectionRange(start + 1, start + 1);
                        });
                      }}
                      title="Mention an agent (or type @)"
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--fg-3)",
                        padding: 0,
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <AtSign className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      title="Attach image"
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--fg-3)",
                        padding: 0,
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      style={{ display: "none" }}
                      onChange={(e) => {
                        if (e.target.files) {
                          addImages(Array.from(e.target.files));
                          e.target.value = "";
                        }
                      }}
                    />
                  </span>
                  <span className="flex items-center" style={{ gap: 8 }}>
                    {uploading && (
                      <span className="mono text-caption" style={{ color: "var(--accent)" }}>
                        uploading…
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={
                        sendMut.isPending ||
                        uploading ||
                        (!draft.trim() && pendingImages.length === 0) ||
                        (requiresMention && draftMentions.length === 0)
                      }
                      title={
                        requiresMention && draftMentions.length === 0
                          ? "Pick at least one recipient with @ before sending in a group chat"
                          : "Send (Enter)"
                      }
                      aria-label="Send"
                      className={cn(
                        "inline-flex items-center justify-center transition-opacity",
                        (sendMut.isPending ||
                          uploading ||
                          (!draft.trim() && pendingImages.length === 0) ||
                          (requiresMention && draftMentions.length === 0)) &&
                          "opacity-40 cursor-not-allowed",
                      )}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "var(--radius-input)",
                        background: "var(--fg)",
                        color: "var(--bg-raised)",
                        border: "none",
                      }}
                    >
                      <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
                    </button>
                  </span>
                </div>
              </div>
              {(sendMut.isError || uploadError) && (
                <p
                  className="mono text-label"
                  style={{
                    color: "var(--state-error)",
                    padding: "var(--sp-1_5) var(--sp-0_5) 0",
                  }}
                >
                  {uploadError ?? (sendMut.error instanceof Error ? sendMut.error.message : "Failed to send")}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Header participant strip: renders one `@name` chip per current chat
 * member plus a `[+]` button to invite more agents (uses
 * `addMeChatParticipants`, which auto-upgrades a 1:1 chat to a group on
 * the server when the resulting count is ≥ 3).
 *
 * Removal isn't implemented yet — the server has no member-side endpoint
 * for `DELETE /me/chats/:id/participants/:agentId`. The display-only
 * `×`-less chip is intentional until that lands.
 */
function ParticipantsHeader({
  chatId,
  participantIds,
  candidates,
  agentIdentity,
  onAdded,
  readOnly = false,
}: {
  chatId: string;
  participantIds: string[];
  candidates: MentionCandidate[];
  /** Identity resolver covering ALL agents (incl. the viewer's own,
   *  which `mentionCandidates` excludes). Lets the chip row label
   *  self correctly instead of falling back to a UUID prefix. */
  agentIdentity: (uuid: string | null | undefined) => { name: string | null; displayName: string } | null;
  onAdded: () => void;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(ev.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const addMut = useMutation({
    mutationFn: (agentId: string) => addMeChatParticipants(chatId, { participantIds: [agentId] }),
    onSuccess: () => {
      setOpen(false);
      onAdded();
    },
  });

  const outsideCandidates = useMemo(
    () => candidates.filter((c) => !participantIds.includes(c.agentId)),
    [candidates, participantIds],
  );

  return (
    <div className="inline-flex items-center flex-wrap" style={{ gap: 4 }}>
      {participantIds.map((id) => {
        // Prefer `agentIdentity` (covers self) over `candidates`
        // (excludes self by design — see useMentionAutocomplete callers).
        // Falls back to UUID prefix only if both are empty, which
        // shouldn't happen for in-org agents.
        const ident = agentIdentity(id);
        const label = ident?.displayName ?? ident?.name ?? id.slice(0, 8);
        return (
          <span
            key={id}
            className="inline-flex items-center text-label"
            style={{
              padding: "var(--sp-0_5) var(--sp-1_5)",
              borderRadius: "var(--radius-chip)",
              background: "var(--bg-sunken)",
              color: "var(--fg-2)",
            }}
          >
            {label}
          </span>
        );
      })}
      {!readOnly && (
        <div ref={containerRef} style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            disabled={outsideCandidates.length === 0 || addMut.isPending}
            title={outsideCandidates.length === 0 ? "All available agents are already in this chat" : "Add participant"}
            aria-label="Add participant"
            className="inline-flex items-center transition-colors hover:bg-[var(--bg-sunken)]"
            style={{
              padding: "var(--sp-0_5) var(--sp-1)",
              borderRadius: "var(--radius-chip)",
              border: "var(--hairline) solid var(--border)",
              background: "transparent",
              color: outsideCandidates.length === 0 ? "var(--fg-4)" : "var(--fg-3)",
              cursor: outsideCandidates.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            <Plus className="h-3 w-3" />
          </button>
          {open && outsideCandidates.length > 0 && (
            <div
              role="listbox"
              aria-label="Add participant"
              className="absolute z-20 max-h-56 overflow-auto rounded-md border shadow-lg"
              // Right-anchored so the dropdown grows leftward from the
              // [+] button instead of rightward — chip rows tend to push
              // [+] near the panel edge, where left-anchoring would cause
              // the dropdown to overflow off-screen.
              style={{
                top: "calc(100% + var(--sp-1))",
                right: 0,
                minWidth: 280,
                background: "var(--bg-raised)",
                borderColor: "var(--border)",
              }}
            >
              {(() => {
                const ambiguous = ambiguousDisplayNames(outsideCandidates);
                // Same grouping contract as the new-chat picker: mine
                // first, teammates' second, --border-faint hairline
                // between (only when both groups are non-empty).
                return groupAndSortCandidates(outsideCandidates).map((item) => {
                  if ("divider" in item) {
                    return (
                      <div
                        key="__divider"
                        // See new-chat-draft.tsx — same a11y reasoning.
                        role="presentation"
                        style={{
                          height: "var(--hairline)",
                          background: "var(--border-faint)",
                          margin: "var(--sp-0_5) var(--sp-3)",
                        }}
                      />
                    );
                  }
                  return (
                    <button
                      key={item.agentId}
                      type="button"
                      role="option"
                      aria-selected="false"
                      title={item.name ? `@${item.name}` : undefined}
                      onClick={() => addMut.mutate(item.agentId)}
                      disabled={addMut.isPending}
                      className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-body"
                      style={{
                        background: "transparent",
                        color: "var(--fg)",
                        border: "none",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <MentionLabel candidate={item} ambiguous={ambiguous} />
                    </button>
                  );
                });
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
