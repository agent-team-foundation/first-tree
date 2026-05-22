import {
  CHAT_ENGAGEMENT_STATUSES,
  type ChatParticipantDetail,
  documentContextSchema,
  extractMentions,
  type MentionParticipant,
  parseWorkspaceDocKey,
  type QuestionAnswerMessageContent,
  type QuestionMessageContent,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, AtSign, Check, ExternalLink, Eye, MessageSquare, MoreHorizontal, Paperclip, X } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Components } from "react-markdown";
import { useSearchParams } from "react-router";
import { listAgents } from "../../../api/agents.js";
import {
  type FileMessageContent,
  getChat,
  type ImageRefContent,
  listChatMessages,
  type MessageWithDelivery,
  type PaginatedMessages,
  patchChatEngagement,
  readFileAsBase64,
  renameChat,
  sendChatMessage,
  sendFileMessage,
} from "../../../api/chats.js";
import { getImage, putImage } from "../../../api/image-store.js";
import {
  agentSessionsQueryKey,
  asAssistantTextPayload,
  asErrorPayload,
  getSession,
  listSessionEvents,
  type SessionEventRow,
  type SessionListItem,
} from "../../../api/sessions.js";
import { useAuth } from "../../../auth/auth-context.js";
import { AddParticipantDropdown } from "../../../components/add-participant-dropdown.js";
import { Avatar as RealAvatar } from "../../../components/avatar.js";
import { GithubEventCardMessage, isGithubEventCardContent } from "../../../components/chat/github-event-card.js";
import {
  isQuestionAnswerContent,
  isQuestionContent,
  QuestionMessage,
  type QuestionStatus,
} from "../../../components/chat/question-message.js";
import { WorkingBubble } from "../../../components/chat/working-bubble.js";
import {
  MentionAutocompletePopover,
  type MentionCandidate,
  useMentionAutocomplete,
} from "../../../components/mention-autocomplete.js";
import { Button } from "../../../components/ui/button.js";
import { Markdown } from "../../../components/ui/markdown.js";
import { docPreviewPathFromHref, linkifyMarkdownDocPaths } from "../../../lib/doc-preview-links.js";
import { useAgentIdentityMap, useAgentNameMap, useAgentSlugToIdMap } from "../../../lib/use-agent-name-map.js";
import { useAutoResizeTextarea } from "../../../lib/use-autoresize-textarea.js";
import { usePendingImages } from "../../../lib/use-pending-images.js";
import { cn } from "../../../lib/utils.js";
import { computeRequiresMention } from "../../../utils/requires-mention.js";
import { filterEventsForTimeline } from "../../../utils/session-timeline.js";
import { ChatRightSidebar } from "../right-sidebar/index.js";

const SIDEBAR_OPEN_STORAGE_KEY = "first-tree:chat-right-sidebar:open:v1";

function loadSidebarOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSidebarOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // localStorage may be unavailable (private mode); ignore.
  }
}

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
 * Intermediate assistant reply text surfaced while a turn is still running.
 * These rows are hidden by the turn-grouping filter once the turn ends —
 * the final result is delivered as a regular chat message.
 */
function AssistantTextRow({
  event,
  agentNameFn,
  agentAvatarFn,
  agentColorTokenFn,
  agentId,
}: {
  event: SessionEventRow;
  agentNameFn: (id: string) => string;
  agentAvatarFn: (id: string) => string | null;
  agentColorTokenFn: (id: string) => string | null;
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
      <Avatar
        name={senderName}
        imageUrl={agentAvatarFn(agentId)}
        seed={agentId}
        colorToken={agentColorTokenFn(agentId)}
      />
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

/**
 * Small inline avatar used in the message timeline. Always renders via
 * the shared `<Avatar>` component so every speaker — self, peer agents,
 * humans — gets the same visual treatment: uploaded image when present,
 * otherwise a hue-seeded color disc + first initial. `seed` is the
 * sender's agent UUID, which makes the fallback color stable across
 * reloads and identical to the left-rail `ChatRowAvatar` for the same
 * agent.
 *
 * `name` is typed as required but accepts `undefined` defensively:
 * `useAgentNameMap` should always return a string (uuid fallback), but a
 * version-skewed backend can leak partial message rows where the wire
 * `senderId` is missing entirely. Falling back to "?" keeps the timeline
 * rendering instead of crashing the whole chat view.
 */
function Avatar({
  name,
  imageUrl,
  seed,
  colorToken,
}: {
  name: string;
  imageUrl?: string | null;
  seed?: string;
  colorToken?: string | null;
}) {
  const safeName = name ?? "?";
  return (
    <RealAvatar
      src={imageUrl ?? null}
      name={safeName}
      seed={seed ?? safeName}
      colorToken={colorToken ?? null}
      size={20}
    />
  );
}

function TextRow({
  msg,
  myAgentId,
  agentNameFn,
  agentAvatarFn,
  agentColorTokenFn,
}: {
  msg: MessageWithDelivery;
  myAgentId: string | null;
  agentNameFn: (id: string) => string;
  agentAvatarFn: (id: string) => string | null;
  agentColorTokenFn: (id: string) => string | null;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const slugToId = useAgentSlugToIdMap();
  const senderName = agentNameFn(msg.senderId);
  const isSelf = myAgentId === msg.senderId;
  const docBasePath = documentBasePathFromMetadata(msg.metadata);
  const docSnapshots = useMemo(() => documentSnapshotMapFromMetadata(msg.metadata), [msg.metadata]);
  // Linkify plain `.md` mentions only on agent-sourced messages. Anything the
  // user typed in the web composer (`source === "web"`) is left untouched
  // so paths that humans write — code-fence walkthroughs, quoted snippets,
  // intentional bare references — render exactly as authored. Only paths that
  // this message actually carries a snapshot for get linkified, so a filename
  // the agent only *mentions* in prose stays plain text instead of becoming a
  // dead link — and every link that does render opens from cache without a
  // server round-trip.
  const textContent = useMemo<string | null>(() => {
    if (msg.format !== "text" && msg.format !== "markdown") return null;
    if (typeof msg.content !== "string") return JSON.stringify(msg.content);
    if (msg.source === "web") return msg.content;
    const snapshotPaths = new Set(docSnapshots?.keys() ?? []);
    return linkifyMarkdownDocPaths(msg.content, snapshotPaths, msg.chatId);
  }, [msg.format, msg.content, msg.source, msg.chatId, docSnapshots]);
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ href, children, ...props }) {
        const onClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
          if (
            !href ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.altKey ||
            event.ctrlKey ||
            event.shiftKey
          ) {
            return;
          }

          const docPath = docPreviewPathFromHref(href);
          if (!docPath) return;

          event.preventDefault();
          const next = new URLSearchParams(searchParams);
          next.set("docChat", msg.chatId);
          // Owner attribution for `docAgent`: a global cross-agent key
          // `<ownerSlug>/<chatId>/…` (chatId segment === this chat) belongs to
          // the OWNER, not the sender; self / legacy bare keys stay the sender.
          // `docAgent` is only a hint here — the drawer authoritatively
          // re-resolves the owner from the key's own slug for the path-based
          // fallback (review P2-a), so an unresolved owner does NOT mis-query
          // the sender's workspace; it just leaves this placeholder in the URL
          // for `hasDocRef`. The inline snapshot path renders from cache
          // regardless of `docAgent`.
          const parsedKey = parseWorkspaceDocKey(docPath);
          const ownerId =
            parsedKey && parsedKey.chatId === msg.chatId
              ? (slugToId(parsedKey.agentSlug) ?? msg.senderId)
              : msg.senderId;
          next.set("docAgent", ownerId);
          next.set("docPath", docPath);

          // Prefer the inline snapshot variant: hand the drawer the bytes via
          // React Query cache (keyed by chat+message+path) and tag the URL
          // with the source message id. Falls back to path-based legacy
          // preview when the agent emitted only a `kind: "path"` context.
          //
          // Seed the ENTIRE message's docs[] in one shot — not just the
          // clicked one — so when the drawer's internal markdown links jump
          // between snapshots in the same message they still hit cache and
          // avoid the legacy network round-trip.
          const snapshot = docSnapshots?.get(docPath);
          if (snapshot && docSnapshots) {
            for (const entry of docSnapshots.values()) {
              queryClient.setQueryData(docSnapshotQueryKey(msg.chatId, msg.id, entry.path), entry);
            }
            next.set("docMsg", msg.id);
            next.delete("docBase");
          } else {
            next.delete("docMsg");
            if (docBasePath) {
              next.set("docBase", docBasePath);
            } else {
              next.delete("docBase");
            }
          }
          setSearchParams(next);
        };

        return (
          <a {...props} href={href} onClick={onClick} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [docBasePath, docSnapshots, msg.chatId, msg.id, msg.senderId, queryClient, searchParams, setSearchParams, slugToId],
  );

  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1_5) 0",
      }}
    >
      <Avatar
        name={senderName}
        imageUrl={agentAvatarFn(msg.senderId)}
        seed={msg.senderId}
        colorToken={agentColorTokenFn(msg.senderId)}
      />
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
          ) : msg.format === "text" || msg.format === "markdown" ? (
            <Markdown components={markdownComponents}>{textContent ?? ""}</Markdown>
          ) : msg.format === "card" && isGithubEventCardContent(msg.content) ? (
            <GithubEventCardMessage content={msg.content} />
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

function documentBasePathFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const parsed = documentContextSchema.safeParse(metadata?.documentContext);
  if (!parsed.success) return undefined;
  // Only the path-based legacy variant exposes basePath; snapshot variants
  // carry inline content rendered through a separate path.
  return parsed.data.kind === "path" ? parsed.data.basePath : undefined;
}

export type DocSnapshotEntry = { path: string; content: string; sha256: string; size: number };

/**
 * For snapshot-variant `documentContext`, return a map from `docs[].path` to
 * the snapshot record. Path-based or absent variants return `undefined`.
 * The map keys match the raw href that the agent emitted, so the chat link
 * click handler can use the clicked href directly as a lookup key.
 */
export function documentSnapshotMapFromMetadata(
  metadata: Record<string, unknown> | undefined,
): Map<string, DocSnapshotEntry> | undefined {
  const parsed = documentContextSchema.safeParse(metadata?.documentContext);
  if (!parsed.success || parsed.data.kind !== "snapshot") return undefined;
  const map = new Map<string, DocSnapshotEntry>();
  for (const doc of parsed.data.docs) {
    map.set(doc.path, { path: doc.path, content: doc.content, sha256: doc.sha256, size: doc.size });
  }
  return map;
}

export function docSnapshotQueryKey(chatId: string, messageId: string, path: string): readonly unknown[] {
  return ["chat-doc-snapshot", chatId, messageId, path] as const;
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
  agentAvatarFn,
  agentColorTokenFn,
}: {
  msg: MessageWithDelivery;
  chatId: string;
  content: QuestionMessageContent;
  answer: QuestionAnswerMessageContent | null;
  status: QuestionStatus;
  agentNameFn: (id: string) => string;
  agentAvatarFn: (id: string) => string | null;
  agentColorTokenFn: (id: string) => string | null;
}) {
  const senderName = agentNameFn(msg.senderId);
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1_5) 0",
      }}
    >
      <Avatar
        name={senderName}
        imageUrl={agentAvatarFn(msg.senderId)}
        seed={msg.senderId}
        colorToken={agentColorTokenFn(msg.senderId)}
      />
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
function QuestionAnswerRow({
  msg,
  agentNameFn,
  agentAvatarFn,
  agentColorTokenFn,
}: {
  msg: MessageWithDelivery;
  agentNameFn: (id: string) => string;
  agentAvatarFn: (id: string) => string | null;
  agentColorTokenFn: (id: string) => string | null;
}) {
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
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: 8,
        padding: "var(--sp-1_5) 0",
      }}
    >
      <Avatar
        name={senderName}
        imageUrl={agentAvatarFn(msg.senderId)}
        seed={msg.senderId}
        colorToken={agentColorTokenFn(msg.senderId)}
      />
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

type TimelineItem =
  | { kind: "message"; at: string; key: string; data: MessageWithDelivery }
  | { kind: "event"; at: string; key: string; data: SessionEventRow }
  | { kind: "workgroup"; at: string; key: string; events: SessionEventRow[] };

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
  const [searchParams, setSearchParams] = useSearchParams();
  const agentName = useAgentNameMap();
  const agentIdentity = useAgentIdentityMap();
  /**
   * Avatar URL resolver derived from the identity map: returns the
   * sender's resolved avatar (uploaded agent image, or — for human
   * agents — the backing user's GitHub avatar). `null` when the agent
   * is missing from the identity map or has no avatar; the timeline
   * row's `<Avatar>` then falls back to a hue-seeded color disc +
   * initial.
   */
  const agentAvatar = useCallback((id: string) => agentIdentity(id)?.avatarImageUrl ?? null, [agentIdentity]);
  /**
   * Manager-selected hue override (`hue-0..7`) for the sender. `null`
   * when no override is set, in which case the fallback hue is derived
   * from a deterministic djb2 hash on the agent UUID. Threading this
   * through the timeline keeps a manager's color choice in sync with
   * `ChatRowAvatar` on the left rail (both feed `resolveAvatarHue`).
   */
  const agentColorToken = useCallback((id: string) => agentIdentity(id)?.avatarColorToken ?? null, [agentIdentity]);
  const { agentId: myAgentId, memberId: myMemberId } = useAuth();
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { pendingImages, addImages, removeImage, clearImages } = usePendingImages({
    onError: setUploadError,
    // Dismiss a stale upload error (e.g. "image too large") the moment the
    // user adds or removes an image — they're already fixing it.
    onChange: () => setUploadError(null),
  });
  // Right-rail visibility — defaults to hidden so the chat area gets the
  // full reading column; user opens via the header icon and the choice
  // persists across chats (a global preference, not per-chat).
  const [showSidebar, setShowSidebar] = useState<boolean>(loadSidebarOpen);
  useEffect(() => {
    saveSidebarOpen(showSidebar);
  }, [showSidebar]);
  // Doc-preview opens to the right of chat-view (mounted at workspace level);
  // we render two right rails on the same row, so when the user clicks a doc
  // link we collapse this sidebar to give the preview the right slot it
  // expects. Stash whether the sidebar was visible at the moment doc-preview
  // opened so we can auto-restore it when the preview closes — the user did
  // not ask to dismiss the sidebar, they only opened a doc.
  const hasDocPreview = Boolean(searchParams.get("docChat") && searchParams.get("docPath"));
  const sidebarBeforeDocPreviewRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (hasDocPreview) {
      if (sidebarBeforeDocPreviewRef.current === null) {
        sidebarBeforeDocPreviewRef.current = showSidebar;
        if (showSidebar) setShowSidebar(false);
      }
    } else if (sidebarBeforeDocPreviewRef.current !== null) {
      const restore = sidebarBeforeDocPreviewRef.current;
      sidebarBeforeDocPreviewRef.current = null;
      if (restore) setShowSidebar(true);
    }
  }, [hasDocPreview, showSidebar]);
  const toggleSidebar = useCallback(() => {
    // When doc-preview is open the sidebar icon means "swap to chat
    // details": close the preview AND open the sidebar in one click.
    // Without this branch the click would only flip showSidebar, which
    // the auto-restore effect above would immediately revert because
    // hasDocPreview is still true.
    if (hasDocPreview) {
      const next = new URLSearchParams(searchParams);
      next.delete("docChat");
      next.delete("docAgent");
      next.delete("docPath");
      next.delete("docBase");
      next.delete("docMsg");
      setSearchParams(next, { replace: true });
      sidebarBeforeDocPreviewRef.current = true;
      return;
    }
    setShowSidebar((v) => !v);
  }, [hasDocPreview, searchParams, setSearchParams]);
  // Esc closes the rail when it's open AND the focus is not inside an
  // editable element (textarea / input). Otherwise pressing Esc to
  // dismiss an IME composition or clear a draft would unexpectedly
  // collapse the rail too. Skip while doc-preview owns the right rail —
  // its own component handles Esc to close itself.
  useEffect(() => {
    if (!showSidebar || hasDocPreview) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable) return;
      }
      setShowSidebar(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hasDocPreview, showSidebar]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  const { data: messagesData } = useQuery({
    queryKey: ["chat-messages", chatId],
    queryFn: () => listChatMessages(chatId, { limit: 50 }),
  });

  // Fetch newest events first so the turn-grouping filter always sees the
  // latest `turn_end` even in chats with thousands of total events. The
  // timeline renderer later sorts by timestamp, so the fetch order is moot
  // for display — only the contents of the window matter.
  const { data: eventsData } = useQuery({
    queryKey: ["session-events", agentId, chatId],
    queryFn: () => listSessionEvents(agentId, chatId, { limit: 200, direction: "desc" }),
  });

  const { data: chatDetail, isLoading: chatDetailLoading } = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    enabled: !!chatId,
  });

  /** Org-wide agent list, consumed only by the ParticipantsHeader `[+]`
   *  dropdown via `addableCandidates`. The `@` autocomplete is
   *  membership-scoped (`mentionCandidates` below) and does NOT read
   *  from this list — inviting a new agent goes through the `[+]`
   *  button explicitly, not through `@<outsider>`. Also feeds
   *  `managedByMeMap` for picker grouping.
   *
   *  Backed by `GET /orgs/:orgId/agents` (`listAgents`) rather than
   *  `/activity`: the activity feed filters on `runtimeState IS NOT NULL`
   *  to mean "AI agents with a live runtime", which drops human members
   *  entirely (humans never bind a runtime). See issue 343. `limit: 100`
   *  is the server's enforced cap in `paginationQuerySchema`; orgs above
   *  that threshold need pagination here. */
  const { data: orgAgentsPage } = useQuery({
    queryKey: ["org-agents"],
    queryFn: () => listAgents({ limit: 100 }),
    refetchInterval: 30_000,
  });

  /**
   * Optimistic-update helpers for the messages cache. Wrap setQueryData so
   * the POST-then-refetch round trip doesn't gate the user's own message
   * from appearing above the composer — we render a `pending` row instantly
   * and reconcile with the server's row once the request resolves. Shared
   * between text-only (sendMut) and the image upload path (handleSend).
   *
   * The query key is memoized so the three useCallback wrappers below get a
   * stable reference (otherwise a new `[...]` literal every render would
   * invalidate the callbacks on every parent re-render).
   */
  const messagesQueryKey = useMemo(() => ["chat-messages", chatId] as const, [chatId]);
  const insertOptimisticMessage = useCallback(
    (msg: MessageWithDelivery) => {
      queryClient.setQueryData<PaginatedMessages>(messagesQueryKey, (prev) => ({
        items: [...(prev?.items ?? []), msg],
        nextCursor: prev?.nextCursor ?? null,
      }));
    },
    [queryClient, messagesQueryKey],
  );
  const replaceOptimisticMessage = useCallback(
    (tempId: string, saved: MessageWithDelivery) => {
      queryClient.setQueryData<PaginatedMessages>(messagesQueryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((m) => (m.id === tempId ? { ...saved, deliveryStatus: "sent" as const } : m)),
        };
      });
    },
    [queryClient, messagesQueryKey],
  );
  const removeOptimisticMessages = useCallback(
    (tempIds: ReadonlySet<string>) => {
      if (tempIds.size === 0) return;
      queryClient.setQueryData<PaginatedMessages>(messagesQueryKey, (prev) => {
        if (!prev) return prev;
        return { ...prev, items: prev.items.filter((m) => !tempIds.has(m.id)) };
      });
    },
    [queryClient, messagesQueryKey],
  );
  const buildOptimisticTextMessage = useCallback(
    (text: string): MessageWithDelivery | null => {
      if (!myAgentId) return null;
      return {
        id: `optimistic-${crypto.randomUUID()}`,
        chatId,
        senderId: myAgentId,
        format: "text",
        content: text,
        metadata: {},
        inReplyTo: null,
        source: "web",
        createdAt: new Date().toISOString(),
        deliveryStatus: "pending",
      };
    },
    [chatId, myAgentId],
  );

  const sendMut = useMutation({
    mutationFn: (content: string) => sendChatMessage(chatId, content),
    // Optimistic insert: render the user's row above the composer immediately
    // and clear the draft so the input feels responsive even when the POST
    // round-trip + follow-up GET take 1–2s. The ctx returned here is threaded
    // to onError / onSuccess so we can reconcile with the server row.
    onMutate: async (content: string) => {
      await queryClient.cancelQueries({ queryKey: messagesQueryKey });
      const previousDraft = draft;
      setDraft("");
      const optimistic = buildOptimisticTextMessage(content);
      if (!optimistic) return { tempId: null, previousDraft };
      insertOptimisticMessage(optimistic);
      return { tempId: optimistic.id, previousDraft };
    },
    onSuccess: (saved, _content, ctx) => {
      if (ctx?.tempId) replaceOptimisticMessage(ctx.tempId, saved);
      // Refresh the workspace sidebar the moment the message is durable —
      // server's predictive Step 1b (in services/message.ts) just upserted an
      // `active` agent_chat_sessions row, so the new chat now satisfies the
      // listAgentSessions INNER JOIN. Without this invalidate the user would
      // wait up to 10s for the polling refetch. See M plan Step 3 in
      // docs/session-creation-on-first-message.md.
      queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(agentId) });
    },
    // Server-side `enforceGroupMention` + unresolved-token guard 400s
    // (e.g. user typed `@<outsider>` who's not in the chat) surface here.
    // Client no longer pre-flights — unresolved `@<token>` is treated as
    // plain text locally; the round-trip is the user's notification.
    onError: (err, _content, ctx) => {
      setUploadError(err instanceof Error ? err.message : "Failed to send message");
      if (ctx?.tempId) removeOptimisticMessages(new Set([ctx.tempId]));
      // Put the rejected text back so the user can edit and retry without
      // re-typing — but only if the user hasn't already started typing
      // something new during the in-flight window. Setting `previousDraft`
      // unconditionally would overwrite the new keystrokes (PR review
      // observation #1). Functional setState reads the latest draft inside
      // React's commit so we don't race the textarea's controlled value.
      if (ctx?.previousDraft) setDraft((current) => (current === "" ? ctx.previousDraft : current));
    },
    // Resync against the server in the background so any fan-out side-effects
    // (e.g. server-rewritten content, mention resolution) eventually overwrite
    // our optimistic snapshot.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: messagesQueryKey });
    },
  });

  const handleSend = async () => {
    const text = draft.trim();
    const images = pendingImages;
    if (!text && images.length === 0) return;
    if (uploading) return;

    // No client-side unresolved-`@`-token pre-flight: a `@<token>` that
    // doesn't resolve to a chat member is treated as plain text, matching
    // Slack/Discord/Feishu. This avoids false positives like npm scoped
    // package names (`@scope/pkg`) or quoted handles in the body. The
    // `enforceGroupMention` constraint (group chat must address at least
    // one member) is reflected via `requiresMention` + `draftMentions`
    // gating the send button below — `extractMentions` resolves only
    // against in-chat membership, so an `@<outsider>` simply contributes
    // nothing and the button stays disabled, prompting the user to use
    // the `[+]` button or the autocomplete picker.

    // Group-chat send guard: don't fire requests we know the server (with
    // proposal §3 enforcement) or downstream `mention_only` agents will drop.
    // Applies to image-only sends too — the server-side mention check runs
    // per message regardless of format, so an image without an addressee
    // would 400 just like a text without an addressee (issue 387). Surface
    // a hint when the user has only attached images so the silent-return
    // doesn't look like a stuck send.
    if (requiresMention && draftMentions.length === 0) {
      if (images.length > 0) {
        // English matches the other uploadError strings in this file
        // (Failed to send image / Failed to add participants / Image too large).
        setUploadError("@mention a group member in the text — images will be addressed to the same recipient(s).");
      }
      return;
    }

    if (images.length > 0) {
      setUploading(true);
      setUploadError(null);
      // Carry the text-draft mentions onto each image message so the
      // server's group-chat mention guard (services/message.ts) accepts
      // file-format sends. Without this, every image POST is missing
      // recipient mentions and 400s before the text message is sent
      // (issue 387). In direct chats `draftMentions` is empty and the
      // metadata field is omitted entirely — server check is skipped
      // anyway, so this is a no-op for 1:1.
      const imageMetadata = draftMentions.length > 0 ? { mentions: draftMentions } : undefined;
      // Snapshot draft + clear inputs up front so the composer feels instant.
      // Optimistic rows render into the cache below; rollback restores both
      // the textarea draft and any not-yet-acked optimistic tempIds on error.
      const previousDraft = draft;
      setDraft("");
      clearImages();
      await queryClient.cancelQueries({ queryKey: messagesQueryKey });
      const pendingTempIds = new Set<string>();
      try {
        for (const img of images) {
          const data = await readFileAsBase64(img.file);
          const imageId = crypto.randomUUID();
          // Write to IndexedDB before the POST so the sending tab can render
          // its own message via the imageRef shape immediately on refetch,
          // even if the server write races ahead of the response.
          await putImage({ imageId, base64: data, mimeType: img.file.type });
          let tempId: string | null = null;
          if (myAgentId) {
            const imageRef: ImageRefContent = {
              imageId,
              mimeType: img.file.type,
              filename: img.file.name,
              size: img.file.size,
            };
            const optimistic: MessageWithDelivery = {
              id: `optimistic-${crypto.randomUUID()}`,
              chatId,
              senderId: myAgentId,
              format: "file",
              content: imageRef,
              metadata: imageMetadata ?? {},
              inReplyTo: null,
              source: "web",
              createdAt: new Date().toISOString(),
              deliveryStatus: "pending",
            };
            tempId = optimistic.id;
            pendingTempIds.add(tempId);
            insertOptimisticMessage(optimistic);
          }
          const saved = await sendFileMessage(
            chatId,
            {
              data,
              mimeType: img.file.type,
              filename: img.file.name,
              size: img.file.size,
              imageId,
            },
            imageMetadata,
          );
          if (tempId) {
            replaceOptimisticMessage(tempId, saved);
            pendingTempIds.delete(tempId);
          }
        }
        if (text) {
          const optimistic = buildOptimisticTextMessage(text);
          const tempId = optimistic?.id ?? null;
          if (optimistic && tempId) {
            pendingTempIds.add(tempId);
            insertOptimisticMessage(optimistic);
          }
          const saved = await sendChatMessage(chatId, text);
          if (tempId) {
            replaceOptimisticMessage(tempId, saved);
            pendingTempIds.delete(tempId);
          }
        }
        // Mirror sendMut.onSettled: predictive session-activation only shows
        // up in the sidebar after we invalidate, otherwise the file-send path
        // for the first message in a new chat waits for 10s polling.
        queryClient.invalidateQueries({ queryKey: messagesQueryKey });
        queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(agentId) });
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Failed to send image");
        // Roll back unacknowledged optimistic rows + restore the draft so the
        // user can retry. Already-acked rows have been swapped to real ids by
        // replaceOptimisticMessage and are no longer in pendingTempIds.
        removeOptimisticMessages(pendingTempIds);
        // Only restore the pre-send draft if the user hasn't already started
        // typing something new during the upload window (PR review
        // observation #1).
        if (previousDraft) setDraft((current) => (current === "" ? previousDraft : current));
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

  // Deleted chats have no row in the conversation list — this banner is the
  // sole recovery entry point.
  const restoreMut = useMutation({
    mutationFn: () => patchChatEngagement(chatId, CHAT_ENGAGEMENT_STATUSES.ACTIVE),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
      queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
    },
  });

  /**
   * Timeline composition: messages (real chat rows, including the forwarded
   * final result) are always visible; transient events go through the
   * turn-grouping filter so completed turns collapse to just their result
   * message. See `filterEventsForTimeline` for the full rules.
   *
   * Second pass collapses adjacent `tool_call` + `thinking` rows into a
   * single `workgroup` entry — these become the inline WorkingBubble. Any
   * non-bubble item (message, assistant_text, error) flushes the current
   * bucket, so intermediate streamed text stays visible as its own row
   * even when surrounded by tool calls.
   */
  const items: TimelineItem[] = useMemo(() => {
    const msgs = messagesData?.items ?? [];
    const rawEvents = eventsData?.items ?? [];
    const visibleEvents = filterEventsForTimeline(rawEvents);

    // Turn id = the seq of the last turn_end seen across all events, including
    // ones filterEventsForTimeline dropped. Every visible transient event has
    // seq > lastTurnEndSeq, so each turn gets a unique stable anchor that
    // survives toolUseId dedupe (where individual event ids change as
    // pending → final updates flow in). Used to build remount-safe bubble
    // keys so the user's manual open/closed toggle isn't reset when a single
    // tool call's pending row gets replaced by its final-status row.
    let lastTurnEndSeq = -1;
    for (const e of rawEvents) {
      if (e.kind === "turn_end" && e.seq > lastTurnEndSeq) lastTurnEndSeq = e.seq;
    }

    const flat: TimelineItem[] = [
      ...msgs.map((m) => ({ kind: "message" as const, at: m.createdAt, key: `m-${m.id}`, data: m })),
      ...visibleEvents.map((e) => ({ kind: "event" as const, at: e.createdAt, key: `e-${e.id}`, data: e })),
    ];
    flat.sort((a, b) => a.at.localeCompare(b.at));

    const grouped: TimelineItem[] = [];
    let bucket: SessionEventRow[] = [];
    let bucketIndex = 0;
    const flushBucket = () => {
      const first = bucket[0];
      if (!first) return;
      grouped.push({
        kind: "workgroup",
        at: first.createdAt,
        key: `wg-${lastTurnEndSeq}-${bucketIndex}`,
        events: bucket,
      });
      bucketIndex += 1;
      bucket = [];
    };
    for (const item of flat) {
      if (item.kind === "event" && (item.data.kind === "tool_call" || item.data.kind === "thinking")) {
        bucket.push(item.data);
        continue;
      }
      flushBucket();
      grouped.push(item);
    }
    flushBucket();
    return grouped;
  }, [messagesData, eventsData]);

  /**
   * For every `format=question` message we render, we need the matching
   * `question_answer` (when one has landed). Build a (correlationId →
   * answer-content) lookup once per messages refresh — there's no separate
   * pending-status endpoint yet, so the presence of the answer message is
   * the canonical "answered" signal. v1 collapses superseded into pending
   * since we don't have a WS-pushed supersede signal yet (commit 6).
   */
  const answersByCorrelationId = useMemo(() => {
    const map = new Map<string, QuestionAnswerMessageContent>();
    for (const m of messagesData?.items ?? []) {
      if (m.format !== "question_answer") continue;
      if (isQuestionAnswerContent(m.content)) {
        map.set(m.content.correlationId, m.content);
      }
    }
    return map;
  }, [messagesData]);

  const itemCount = items.length;
  useEffect(() => {
    if (itemCount > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [itemCount]);

  /**
   * Chat-scoped identity index. The chat detail endpoint resolves each
   * participant's `name / displayName / type` via JOIN `agents` without
   * applying `agentVisibilityCondition`, so private agents that are
   * members of this chat carry their real labels here — the identity
   * map (`useAgentNameMap` / `useAgentIdentityMap`) goes through the
   * org-scoped `/agents` endpoint and would drop them. The chat
   * membership is the authoritative trust boundary for in-chat identity
   * rendering; see
   * `docs/agent-space-and-mention-visibility-design.zh-CN.md` §4.3.3.
   */
  const chatParticipantById = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string | null;
        displayName: string;
        avatarImageUrl: string | null;
        avatarColorToken: string | null;
      }
    >();
    for (const p of chatDetail?.participants ?? []) {
      map.set(p.agentId, {
        name: p.name,
        displayName: p.displayName,
        avatarImageUrl: p.avatarImageUrl ?? null,
        avatarColorToken: p.avatarColorToken ?? null,
      });
    }
    return map;
  }, [chatDetail?.participants]);

  /**
   * Resolve an agentId to a display label, preferring the chat-scoped
   * participant index over the org-visibility-filtered identity map.
   * Falls back to the identity map for senders that are no longer in
   * the chat (e.g. historical messages after a future remove flow lands)
   * and to the raw UUID prefix as a last resort.
   */
  const chatScopedAgentName = useCallback(
    (id: string | null | undefined): string => {
      if (!id) return "—";
      const p = chatParticipantById.get(id);
      if (p) return p.displayName;
      return agentName(id);
    },
    [chatParticipantById, agentName],
  );

  /**
   * Identity-pair variant used by the participant chip row and the
   * mention picker. Same precedence rule as `chatScopedAgentName`.
   */
  const chatScopedAgentIdentity = useCallback(
    (
      id: string | null | undefined,
    ): {
      name: string | null;
      displayName: string;
      avatarImageUrl: string | null;
      avatarColorToken: string | null;
    } | null => {
      if (!id) return null;
      const p = chatParticipantById.get(id);
      if (p) {
        // Labels come from the chat-membership-authoritative source. The
        // avatar fields are now projected onto `ChatParticipantDetail`
        // too (server JOIN on agents), so prefer the chat-scoped value
        // and only fall back to the org-scoped identity map when the
        // chat row is missing them (older server build, version skew).
        const ident = agentIdentity(id);
        return {
          name: p.name,
          displayName: p.displayName,
          avatarImageUrl: p.avatarImageUrl ?? ident?.avatarImageUrl ?? null,
          avatarColorToken: p.avatarColorToken ?? ident?.avatarColorToken ?? null,
        };
      }
      return agentIdentity(id);
    },
    [chatParticipantById, agentIdentity],
  );

  const displayName = chatScopedAgentName(agentId);

  // `managedByMe` is `managerId === myMemberId`, derived client-side
  // from the `listAgents` response (the row carries `managerId`). Drives
  // the picker's "mine / others" grouping. Agents that appear only via
  // `chatDetail.participants` and not in the org-agents page default to
  // false, so a caller's own private agent in another org could land in
  // the "teammates" group — grouping is a visual hint, not a security
  // boundary, so we accept that fidelity loss.
  const managedByMeMap = useMemo(() => {
    const m = new Map<string, boolean>();
    if (!myMemberId) return m;
    for (const a of orgAgentsPage?.items ?? []) m.set(a.uuid, a.managerId === myMemberId);
    return m;
  }, [orgAgentsPage?.items, myMemberId]);

  // Mention autocomplete candidates: strictly the agents currently in
  // THIS chat (minus self). Driving the `@` popover and `extractMentions`
  // off membership — instead of org-wide discovery — keeps the picker
  // focused on the people who'll actually receive the message. To pull
  // a new agent into the conversation, use the ParticipantsHeader `[+]`
  // button (which is fed by `addableCandidates` below). Any participant
  // without a slug (`name`) is skipped — mentions need one. Private
  // agents in the chat surface here because membership, not discovery,
  // is the source of truth.
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const out: MentionCandidate[] = [];
    for (const p of chatDetail?.participants ?? []) {
      if (p.agentId === myAgentId) continue;
      const ident = chatScopedAgentIdentity(p.agentId);
      if (!ident || !ident.name) continue;
      out.push({
        agentId: p.agentId,
        name: ident.name,
        displayName: ident.displayName,
        managedByMe: managedByMeMap.get(p.agentId) ?? false,
      });
    }
    return out;
  }, [chatDetail?.participants, chatScopedAgentIdentity, myAgentId, managedByMeMap]);

  // Candidates for the ParticipantsHeader `[+]` add-member dropdown:
  // every agent the user might invite, union of current members and
  // org-wide discoverable agents from `/orgs/:orgId/agents`. The
  // dropdown filters out already-joined participants internally, so we
  // pass the union and let it compute `outsideCandidates`. Self is
  // excluded; missing slug is skipped. Suspended rows are excluded so
  // the picker never offers a row the server would refuse on add.
  //
  // Identity resolution: prefer the shared `useAgentIdentityMap`, fall
  // back to the raw `listAgents` row when the map hasn't resolved yet.
  // Both surfaces are fed by `listAgents` ultimately, so the window is
  // short, but on a brand-new teammate's first paint the identity map
  // may not have indexed them yet — without the fallback they'd briefly
  // drop out of the picker. Mirrors the fallback pattern in
  // `new-chat-draft.tsx`.
  const addableCandidates = useMemo<MentionCandidate[]>(() => {
    const orgRowById = new Map<string, { name: string | null; displayName: string }>();
    for (const a of orgAgentsPage?.items ?? []) {
      if (a.status === "suspended") continue;
      orgRowById.set(a.uuid, { name: a.name, displayName: a.displayName });
    }
    const ids = new Set<string>();
    for (const p of chatDetail?.participants ?? []) ids.add(p.agentId);
    for (const id of orgRowById.keys()) ids.add(id);
    if (ids.size === 0) ids.add(agentId);
    const out: MentionCandidate[] = [];
    for (const id of ids) {
      if (id === myAgentId) continue;
      const ident = chatScopedAgentIdentity(id);
      const orgRow = orgRowById.get(id);
      const name = ident?.name ?? orgRow?.name ?? null;
      if (!name) continue;
      const displayName = ident?.displayName ?? orgRow?.displayName ?? null;
      out.push({
        agentId: id,
        name,
        displayName,
        managedByMe: managedByMeMap.get(id) ?? false,
      });
    }
    return out;
  }, [chatDetail?.participants, orgAgentsPage?.items, agentId, chatScopedAgentIdentity, myAgentId, managedByMeMap]);

  /**
   * "Needs explicit @mention" guard: a real group (3+ speakers), OR a 1-on-1
   * where the current user isn't yet a participant (their first send promotes
   * it to a 3-person group). In both cases an unaddressed message would be
   * silently dropped by `mention_only` peers and the server rejects it with
   * 400. See proposals/group-chat-ux-improvements §2.
   *
   * Keyed on **membership shape**, not `chats.type`. Since the group-chat
   * convergence (first-tree PR 465 / first-tree-context PR 281) every chat
   * is created with `type='group'`, so the old `chatDetail.type === "group"`
   * check fired for 1-on-1 DMs too and forced an @mention there — breaking the
   * "DM doesn't need an explicit @mention" UX. The server already keys on
   * shape (`services/message.ts` `isOneOnOne = participants.length === 2`,
   * speakers only); this mirrors it. `chatDetail.participants` is also
   * speakers-only (`getChatDetail` filters `accessMode = 'speaker'`).
   */
  const requiresMention = useMemo(() => {
    if (!chatDetail) return false;
    return computeRequiresMention(
      chatDetail.participants.map((p) => p.agentId),
      myAgentId,
    );
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

  /** AgentIds the draft text addresses via `@<name>` tokens, resolved
   * against the in-chat membership (`mentionCandidates`). Used purely
   * as a UX signal: drives the send-button disable + tooltip when a
   * group chat has no valid mention yet. Unresolved `@<token>` tokens
   * (typos, npm package names, outsiders) contribute nothing here —
   * the button stays disabled, prompting the user to pick from
   * autocomplete or use ParticipantsHeader's `[+]`. The server still
   * runs its own unresolved-token guard on the agent path (the PR-393
   * anti-hallucination fix); on the human web path it's tolerated by the
   * `mentions.ts` regex excluding npm scoped names from token scans. */
  const draftMentions = useMemo(() => {
    const ps: MentionParticipant[] = mentionCandidates.map((c) => ({ agentId: c.agentId, name: c.name }));
    return extractMentions(draft, ps);
  }, [draft, mentionCandidates]);

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
      {/* Chat body: left column owns header + timeline + composer; right
          rail (chat details) sits as an independent column when open.
          Putting the header inside the left column makes its reading-
          column centre share the same base as timeline/composer, so the
          title's left edge naturally aligns with the message avatars
          regardless of whether the right rail is open. */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Chat header — content centred in a reading column that's now
          measured against the left column rather than the full panel.
          Title + EntityLink + ParticipantsStats live in the reading
          column; the chat-level icon strip (UserPlus / MoreHorizontal)
          rides along at the column's right edge so it sits flush with
          the composer's right edge below. */}
          <div
            className="shrink-0 flex items-center"
            style={{
              height: 52,
              padding: "0 var(--sp-6)",
              gap: 10,
              // Subtle raised background instead of a border-bottom: it
              // gives the header a visual block (so it reads as a chrome
              // bar) without the hard line. When the right rail opens,
              // both surfaces share `--bg-raised`, so the header + rail
              // form one continuous L-shaped chrome frame around the
              // timeline + composer reading column.
              background: "var(--bg-raised)",
            }}
          >
            {/* Header content spans edge-to-edge: title hugs the left
            padding, the chat-level icon strip hugs the right. The
            reading-column centering used to live here too, but it pulled
            both ends into the middle of the panel and left the icons
            floating far away from the sidebar boundary. Edge-to-edge
            keeps the icon strip flush with the right rail's left border
            so toggle + sidebar feel like one continuous control. */}
            <div
              className="flex items-center w-full"
              style={{
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
                    <span className="truncate text-subtitle font-semibold min-w-0" style={{ color: "var(--fg)" }}>
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
                        if (e.nativeEvent.isComposing) return;
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
                    className="truncate text-subtitle font-semibold text-left min-w-0"
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
              {/* Audience — compact stats icon + quick-add icon. Replaces
              the previous chip-row, which one-shot the panel width once
              chats grew past three participants. Stats icon shows count
              + hover popover with full name list; the quick-add icon
              opens the same dropdown the sidebar's "+ Add participant"
              uses (shared backend mutation, single one-way-door notice). */}
              <ParticipantsStats
                participants={chatDetail?.participants ?? []}
                chatId={chatId}
                agentIdentity={chatScopedAgentIdentity}
                onOpen={() => setShowSidebar(true)}
              />
              {/* Vertical divider splits "look" (avatar strip = identity +
                  state) from "do" (add / open details). Keeps the four
                  icons from reading as one undifferentiated cluster. */}
              <span
                aria-hidden="true"
                className="shrink-0"
                style={{
                  width: "var(--hairline)",
                  height: "var(--sp-4)",
                  background: "var(--border)",
                  marginLeft: "var(--sp-1)",
                  marginRight: "var(--sp-1)",
                }}
              />
              {readOnly ? null : (
                <AddParticipantDropdown
                  variant="icon"
                  chatId={chatId}
                  participantIds={chatDetail?.participants?.map((p) => p.agentId) ?? [agentId]}
                  candidates={addableCandidates}
                  agentIdentity={chatScopedAgentIdentity}
                  onAdded={() => queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] })}
                />
              )}
              {/* Chat details toggle — opens the right rail (Participants /
              GitHub / Chat actions). Sits at the panel's far right,
              mirroring the rail's position. The "..." glyph matches the
              Teams/Lark convention referenced in the design discussion. */}
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label={showSidebar ? "Hide chat details" : "Show chat details"}
                aria-expanded={showSidebar}
                aria-pressed={showSidebar}
                title={showSidebar ? "Hide chat details" : "Show chat details"}
                className="inline-flex shrink-0 items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
                style={{
                  width: 28,
                  height: 28,
                  border: 0,
                  background: showSidebar ? "var(--bg-sunken)" : "transparent",
                  borderRadius: "var(--radius-input)",
                  color: showSidebar ? "var(--fg)" : "var(--fg-3)",
                  cursor: "pointer",
                }}
              >
                <MoreHorizontal size={16} strokeWidth={2.25} />
              </button>
            </div>
          </div>

          {chatDetail?.engagementStatus === CHAT_ENGAGEMENT_STATUSES.DELETED && (
            <div
              className="shrink-0 flex items-center"
              style={{
                gap: "var(--sp-2)",
                padding: "var(--sp-1_5) var(--sp-6)",
                background: "var(--bg-sunken)",
                borderBottom: "var(--hairline) solid var(--border-faint)",
                color: "var(--fg-2)",
              }}
            >
              <span className="text-body" style={{ flex: 1 }}>
                This chat is deleted and won't appear in your conversation list.
              </span>
              <button
                type="button"
                disabled={restoreMut.isPending}
                onClick={() => restoreMut.mutate()}
                className="text-body"
                style={{
                  padding: "var(--sp-0_5) var(--sp-2)",
                  border: "var(--hairline) solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  background: "var(--bg-raised)",
                  color: "var(--fg)",
                  cursor: restoreMut.isPending ? "default" : "pointer",
                  opacity: restoreMut.isPending ? 0.6 : 1,
                }}
              >
                {restoreMut.isPending ? "Restoring…" : "Restore"}
              </button>
            </div>
          )}

          {/* Timeline. Scroll viewport stays full-width so the scrollbar hugs
          the panel's right edge — pushing it inward would float the column.
          Reading column inside is capped via `maxWidth` and centered to
          align with the composer below into one vertical thread. Side
          padding (sp-6) prevents content from kissing the panel border on
          narrow viewports. */}
          <div className="flex-1 overflow-y-auto relative" style={{ padding: "var(--sp-2_5) var(--sp-6)" }}>
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
                {items.map((item) => {
                  if (item.kind === "workgroup") {
                    // Default to folded while chatDetail is still loading — opening
                    // a group chat's bubble for one frame and then folding it after
                    // chatDetail resolves is worse than under-opening direct chats
                    // by the same one-frame window.
                    return (
                      <WorkingBubble key={item.key} events={item.events} defaultOpen={chatDetail?.type === "direct"} />
                    );
                  }
                  if (item.kind === "event") {
                    const ev = item.data;
                    switch (ev.kind) {
                      case "assistant_text":
                        return (
                          <AssistantTextRow
                            key={item.key}
                            event={ev}
                            agentId={agentId}
                            agentNameFn={chatScopedAgentName}
                            agentAvatarFn={agentAvatar}
                            agentColorTokenFn={agentColorToken}
                          />
                        );
                      case "error":
                        return <ErrorRow key={item.key} event={ev} />;
                      default:
                        // tool_call / thinking are folded into the workgroup above;
                        // turn_end is filtered upstream; anything else is dropped.
                        return null;
                    }
                  }
                  const msg = item.data;
                  if (msg.format === "question" && isQuestionContent(msg.content)) {
                    const answer = answersByCorrelationId.get(msg.content.correlationId) ?? null;
                    const status: QuestionStatus = answer ? "answered" : "pending";
                    return (
                      <QuestionMessageRow
                        key={item.key}
                        msg={msg}
                        chatId={chatId}
                        content={msg.content}
                        answer={answer}
                        status={status}
                        agentNameFn={chatScopedAgentName}
                        agentAvatarFn={agentAvatar}
                        agentColorTokenFn={agentColorToken}
                      />
                    );
                  }
                  if (msg.format === "question_answer") {
                    return (
                      <QuestionAnswerRow
                        key={item.key}
                        msg={msg}
                        agentNameFn={chatScopedAgentName}
                        agentAvatarFn={agentAvatar}
                        agentColorTokenFn={agentColorToken}
                      />
                    );
                  }
                  return (
                    <TextRow
                      key={item.key}
                      msg={msg}
                      myAgentId={myAgentId}
                      agentNameFn={chatScopedAgentName}
                      agentAvatarFn={agentAvatar}
                      agentColorTokenFn={agentColorToken}
                    />
                  );
                })}
              </div>
              <div ref={messagesEndRef} />
            </div>
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
                    // Blend into the timeline surface (`--bg`) rather than a
                    // sunken grey box — the hairline border alone delineates
                    // the slot. Mirrors the editable composer below so the
                    // read-only state occupies the same visual footprint.
                    background: "var(--bg)",
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
                      // Composer blends into the timeline surface (`--bg`)
                      // instead of a sunken grey box; the hairline border
                      // keeps the input field discernible against it.
                      background: "var(--bg)",
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
                          // Dismiss a stale upload error (e.g. the "no @mention"
                          // hint) the moment the user starts fixing it. Mirrors
                          // the unconditional clears in `addImages` / `removeImage`
                          // — React bails on identical setState so the null→null
                          // case is free.
                          setUploadError(null);
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
                          // Skip while an IME is composing so Enter confirms the
                          // candidate instead of sending / picking a mention.
                          if (e.nativeEvent.isComposing) return;
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
        {showSidebar ? (
          <ChatRightSidebar
            chatId={chatId}
            participants={chatDetail?.participants ?? []}
            participantsLoading={chatDetailLoading}
            managedByMe={managedByMeMap}
            addParticipantsCandidates={addableCandidates}
            agentIdentity={chatScopedAgentIdentity}
            onAdded={() => queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] })}
            onClose={() => setShowSidebar(false)}
            readOnly={readOnly}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Stacked-avatar participant strip in the chat header. Renders up to
 * `MAX_VISIBLE` participants as overlapping circular avatars; the remainder
 * collapses into a "+N" chip. Agent avatars carry a status dot in the
 * bottom-right corner (active / idle / suspended / errored), keying off
 * the same per-(agent, chat) session row the sidebar's AgentRow reads.
 *
 * Click any avatar — or the "+N" chip — opens the sidebar's Participants
 * section. Humans render without a dot since "running state" is an
 * agent-only concept here.
 */
const MAX_VISIBLE_AVATARS = 4;

function ParticipantsStats({
  participants,
  chatId,
  agentIdentity,
  onOpen,
}: {
  participants: ChatParticipantDetail[];
  chatId: string;
  agentIdentity: (uuid: string | null | undefined) => {
    name: string | null;
    displayName: string;
    avatarImageUrl: string | null;
    avatarColorToken: string | null;
  } | null;
  onOpen: () => void;
}) {
  if (participants.length === 0) return null;
  const visible = participants.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = participants.length - visible.length;

  return (
    <div className="inline-flex items-center" style={{ paddingLeft: 0 }}>
      {visible.map((p, idx) => (
        <ParticipantAvatar
          key={p.agentId}
          participant={p}
          chatId={chatId}
          agentIdentity={agentIdentity}
          stackIndex={idx}
          onOpen={onOpen}
        />
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Show ${overflow} more participant${overflow === 1 ? "" : "s"}`}
          className="mono text-label inline-flex items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            marginLeft: -8,
            width: 24,
            height: 24,
            borderRadius: 999,
            border: "var(--hairline-bold) solid var(--bg-raised)",
            background: "var(--bg-sunken)",
            color: "var(--fg-3)",
            cursor: "pointer",
          }}
        >
          +{overflow}
        </button>
      ) : null}
    </div>
  );
}

function ParticipantAvatar({
  participant,
  chatId,
  agentIdentity,
  stackIndex,
  onOpen,
}: {
  participant: ChatParticipantDetail;
  chatId: string;
  agentIdentity: (uuid: string | null | undefined) => {
    name: string | null;
    displayName: string;
    avatarImageUrl: string | null;
    avatarColorToken: string | null;
  } | null;
  stackIndex: number;
  onOpen: () => void;
}) {
  const isHuman = participant.type === "human";
  const ident = agentIdentity(participant.agentId);
  const label = ident?.displayName ?? ident?.name ?? participant.agentId.slice(0, 8);

  // Per-agent session state for the dot. Shares the same query key
  // shape as the sidebar's AgentRow so React Query dedupes the request
  // when the sidebar is open. Humans never query (no concept of session).
  const sessionQuery = useQuery<SessionListItem | null>({
    queryKey: ["chat-right-sidebar", "session", participant.agentId, chatId],
    queryFn: async () => {
      try {
        return await getSession(participant.agentId, chatId);
      } catch (err) {
        if (err instanceof Error && err.message.toLowerCase().includes("not found")) return null;
        throw err;
      }
    },
    enabled: !isHuman,
  });

  const state: string | null = isHuman ? null : (sessionQuery.data?.state ?? "none");
  const stateText = state && state !== "none" ? state : isHuman ? "human" : "idle";
  const dot = state ? participantDotView(state) : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${label} · ${stateText}. Open chat details.`}
      title={`${label} · ${stateText}`}
      className="relative inline-flex items-center justify-center transition-transform hover:translate-y-px"
      style={{
        marginLeft: stackIndex === 0 ? 0 : -8,
        zIndex: MAX_VISIBLE_AVATARS - stackIndex,
        border: 0,
        background: "transparent",
        padding: 0,
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: 24,
          height: 24,
          borderRadius: 999,
          border: "var(--hairline-bold) solid var(--bg-raised)",
          overflow: "hidden",
        }}
      >
        <RealAvatar
          src={ident?.avatarImageUrl ?? null}
          name={label}
          seed={participant.agentId}
          colorToken={ident?.avatarColorToken ?? null}
          size={22}
        />
      </span>
      {dot ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dot.bg,
            border: dot.border,
            boxShadow: "0 0 0 var(--hairline-bold) var(--bg-raised)",
          }}
        />
      ) : null}
    </button>
  );
}

/** Dot view-model for agent session states. Mirrors `describeState` in
 * `agent-row.tsx` so the header strip and the sidebar row never disagree
 * about what a given state looks like. Kept inline (rather than imported)
 * because the agent-row helper is intentionally private to that file. */
function participantDotView(state: string): { bg: string; border: string } | null {
  switch (state) {
    case "active":
      return { bg: "var(--state-idle)", border: "none" };
    case "suspended":
      return { bg: "var(--bg-raised)", border: "var(--hairline-bold) solid var(--fg-4)" };
    case "errored":
      return { bg: "var(--state-error)", border: "none" };
    case "evicted":
      return { bg: "var(--state-offline)", border: "none" };
    case "none":
    case "loading":
      // Render nothing — no session row yet, dot would be visual noise.
      return null;
    default:
      return null;
  }
}
