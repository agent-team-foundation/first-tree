import {
  type AttachmentRef,
  attachmentRefsFromMetadata,
  CHAT_ENGAGEMENT_STATUSES,
  type ChatDetail,
  type ChatParticipantDetail,
  type DocSnapshotFailReason,
  documentContextSchema,
  extractMentions,
  isImageBatchRefContent,
  isImageRefContent,
  type MentionParticipant,
  type RequestResolution,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  AtSign,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Menu,
  MessageSquare,
  PanelRight,
  Paperclip,
  X,
} from "lucide-react";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Components } from "react-markdown";
import { useSearchParams } from "react-router";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../../api/agent-status.js";
import { getAgentSkills } from "../../../api/agents.js";
import { fetchAttachmentBase64, uploadImageAttachment } from "../../../api/attachments.js";
import {
  type FileMessageContent,
  getChat,
  getChatTokenUsage,
  type ImageBatchRefContent,
  type ImageRefContent,
  listChatMessages,
  listChatOpenRequests,
  type MessageWithDelivery,
  type PaginatedMessages,
  patchChatEngagement,
  readFileAsBase64,
  renameChat,
  sendChatMessage,
  sendFileMessageBatch,
} from "../../../api/chats.js";
import { getImage, putImage } from "../../../api/image-store.js";
import { cacheMessages, getCachedMessages } from "../../../api/message-store.js";
import { getReadState, type ReadState, setReadState } from "../../../api/read-state-store.js";
import {
  agentSessionsQueryKey,
  asErrorPayload,
  listSessionEvents,
  type SessionEventRow,
} from "../../../api/sessions.js";
import { useAuth } from "../../../auth/auth-context.js";
import { AddParticipantDropdown } from "../../../components/add-participant-dropdown.js";
import { Avatar as RealAvatar } from "../../../components/avatar.js";
import { AgentHovercard } from "../../../components/chat/agent-hovercard.js";
import { AskTakeover } from "../../../components/chat/ask-takeover.js";
import { ComposeStatusBar } from "../../../components/chat/compose-status-bar.js";
import {
  GITHUB_SYSTEM_SENDER_NAME,
  GithubEventCardMessage,
  GithubSystemAvatar,
  isGithubEventCardContent,
  isTrustedGithubDispatcherMessage,
} from "../../../components/chat/github-event-card.js";
import {
  findBlockingRequest,
  findThreadableRequestId,
  readRequestPayload,
} from "../../../components/chat/request-state.js";
import { WorkingTurn } from "../../../components/chat/working-turn.js";
import { HistoryGapBanner } from "../../../components/history-gap-banner.js";
import {
  MentionAutocompletePopover,
  type MentionCandidate,
  useMentionAutocomplete,
} from "../../../components/mention-autocomplete.js";
import { MentionHighlightOverlay } from "../../../components/mention-highlight-overlay.js";
import { NewMessagesPill } from "../../../components/new-messages-pill.js";
import { rehypeMentions } from "../../../components/rehype-mentions.js";
import {
  resolveMentionContext,
  SlashCommandPopover,
  type SlashSystemCommand,
  useSlashCommand,
} from "../../../components/slash-command-autocomplete.js";
import { Button } from "../../../components/ui/button.js";
import { Markdown, type MarkdownProps } from "../../../components/ui/markdown.js";
import { StatusGlyph } from "../../../components/ui/status-glyph.js";
import { UnreadDivider } from "../../../components/unread-divider.js";
import { useChatScroll } from "../../../hooks/use-chat-scroll.js";
import { useReadTracker } from "../../../hooks/use-read-tracker.js";
import { useServerChannel } from "../../../hooks/use-server-channel.js";
import { viewOf } from "../../../lib/agent-status-view.js";
import { attachmentIdFromHref, parseFailedDocHref, wrapFailedDocMentions } from "../../../lib/doc-preview-links.js";
import { parkFailedDraftIfSwitched } from "../../../lib/draft-store.js";
import { isNavigableWebHref } from "../../../lib/safe-href.js";
import { useAgentIdentityMap, useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { useAutoResizeTextarea } from "../../../lib/use-autoresize-textarea.js";
import { useChatDraftText } from "../../../lib/use-chat-draft-text.js";
import { useOrgAgents } from "../../../lib/use-org-agents.js";
import { usePendingImages } from "../../../lib/use-pending-images.js";
import { cn } from "../../../lib/utils.js";
import { selectVisibleMessages } from "../../../utils/agent-final-text-filter.js";
import { findGapAfterMessageId } from "../../../utils/chat-gap.js";
import { computeRequiresMention, shouldPrimeMentionOnFocus } from "../../../utils/requires-mention.js";
import { filterEventsForTimeline } from "../../../utils/session-timeline.js";
import { ChatRightSidebar } from "../right-sidebar/index.js";

const SIDEBAR_OPEN_STORAGE_KEY = "first-tree:chat-right-sidebar:open:v1";

/**
 * Read the user's stored right-rail preference. Returns `null` when the
 * user has never toggled the rail (no stored key) so the caller can apply a
 * description-driven default; an explicit `"1"` / `"0"` is honored as the
 * user's own choice.
 */
function loadSidebarOpen(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (raw === null) return null;
    return raw === "1";
  } catch {
    return null;
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

/**
 * Temporary, staging-only preference: hide agent final-text mirrors (the
 * per-turn output the runtime auto-forwards into chat with
 * `purpose: "agent-final-text"`) so a human watching sees only deliberate
 * sends + human messages. Defaults to OFF (show everything). Purely a view
 * filter — nothing is deleted, and it only ever applies on non-prod channels
 * (the toggle is hidden on prod; see `finalTextToggleEnabled`).
 */
const HIDE_AGENT_FINAL_TEXT_STORAGE_KEY = "first-tree:chat:hide-agent-final-text:v1";

function loadHideAgentFinalText(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HIDE_AGENT_FINAL_TEXT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveHideAgentFinalText(hide: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HIDE_AGENT_FINAL_TEXT_STORAGE_KEY, hide ? "1" : "0");
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

// Compact token count for the composer marker: 1234 → "1.2k", 2_500_000 → "2.5M".
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function ReadReceipt({ msg, myAgentId }: { msg: MessageWithDelivery; myAgentId: string | null }) {
  if (!myAgentId || msg.senderId !== myAgentId) return null;
  const status = msg.deliveryStatus ?? "sent";
  if (status === "acked") {
    return (
      <span className="mono text-caption" style={{ color: "var(--primary)" }} title="Agent has started processing">
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

function ErrorRow({ event, agentNameFn }: { event: SessionEventRow; agentNameFn?: (id: string) => string }) {
  const payload = asErrorPayload(event.payload);
  const ts = formatClockTime(event.createdAt);
  // Resolve the emitting agent so the header reads "error · <agent> · runtime · …".
  // Falls back gracefully if the lookup function isn't provided (legacy callers).
  const agentName = agentNameFn ? agentNameFn(event.agentId) : null;
  return (
    <div
      // Anchor for the compose rail's jump-to-timeline (failed → this agent's error).
      data-error-agent={event.agentId}
      style={{
        padding: "var(--sp-1_5) var(--sp-2_5)",
        borderLeft: "var(--hairline-bold) solid var(--state-error)",
        // Intentionally fainter than --state-error-soft (14%): this inline error row
        // already carries a solid --hairline-bold error borderLeft, so the wash stays at 6%.
        background: "color-mix(in oklch, var(--state-error) 6%, transparent)",
        borderRadius: "0 var(--radius-input) var(--radius-input) 0",
      }}
    >
      <div className="mono uppercase text-caption" style={{ color: "var(--state-error)" }}>
        error{agentName ? ` · ${agentName}` : ""} · {payload?.source ?? "unknown"} · {ts}
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

type MessageRowProps = {
  msg: MessageWithDelivery;
  myAgentId: string | null;
  agentNameFn: (id: string) => string;
  agentAvatarFn: (id: string) => string | null;
  agentColorTokenFn: (id: string) => string | null;
  mentionParticipants: MentionParticipant[];
};

type MessageBodyProps = {
  msg: MessageWithDelivery;
  myAgentId: string | null;
  mentionParticipants: MentionParticipant[];
};

type MessageMarkdownProps = {
  children: string;
  components: Components;
  rehypePlugins: MarkdownProps["rehypePlugins"];
};

const MessageMarkdown = memo(function MessageMarkdown({ children, components, rehypePlugins }: MessageMarkdownProps) {
  return (
    <Markdown components={components} rehypePlugins={rehypePlugins}>
      {children}
    </Markdown>
  );
});

const MessageBody = memo(function MessageBody({ msg, myAgentId, mentionParticipants }: MessageBodyProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  // Generic attachment refs (doc-preview is the first consumer; kind:
  // "document"). Keyed by attachmentId so the `attachment:<id>` link click can
  // look the ref up and seed the drawer's cache. Old messages (legacy inline
  // shape) have no `metadata.attachments` -> empty map -> no preview, plain text.
  const docAttachmentRefs = useMemo(() => {
    const map = new Map<string, AttachmentRef>();
    for (const ref of attachmentRefsFromMetadata(msg.metadata)) {
      if (ref.kind === "document") map.set(ref.attachmentId, ref);
    }
    return map;
  }, [msg.metadata]);
  const failedDocMentions = useMemo(() => failedDocMentionsFromMetadata(msg.metadata), [msg.metadata]);
  // Successful doc captures are already explicit `[display](attachment:<id>)`
  // links the runtime rewrote into the message body — web does NOT re-linkify
  // bare tokens any more. The only scanner-driven rewrite left is wrapping the
  // runtime-reported FAILED mentions into inert-chip placeholder hrefs
  // (`#doc-failed?reason=...`); the `a` override renders those as disabled chips.
  // Web-composed messages (`source === "web"`) are left untouched so paths a
  // human types render exactly as authored.
  const textContent = useMemo<string | null>(() => {
    // `request` is included so RequestCard's `body` (the long narrative /
    // decision context) renders through the same markdown path as
    // text/markdown — without this it falls back to "" and the card shows
    // only the chip + answer block (QA: missing body on expanded requests).
    if (msg.format !== "text" && msg.format !== "markdown" && msg.format !== "request") return null;
    if (typeof msg.content !== "string") return JSON.stringify(msg.content);
    if (msg.source === "web") return msg.content;
    if (failedDocMentions && failedDocMentions.size > 0) {
      return wrapFailedDocMentions(msg.content, failedDocMentions);
    }
    return msg.content;
  }, [msg.format, msg.content, msg.source, failedDocMentions]);
  // Highlight `@<participant>` tokens in sent messages with the same
  // chip styling the composer's mirror overlay uses. Code blocks and
  // link text are skipped by the plugin itself, so a message containing
  // `\`@param\`` or a quoted handle inside a markdown link keeps its
  // original rendering. `selfAgentId` flips chips that target the viewer
  // into a higher-priority tone — see `.mention-chip.is-self` in index.css.
  const messageRehypePlugins = useMemo(
    () => [rehypeMentions(mentionParticipants, { selfAgentId: myAgentId })],
    [mentionParticipants, myAgentId],
  );
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ href, children, ...props }) {
        // Inert chip for runtime-reported snapshot failures: the magic
        // `#doc-failed?reason=...` href is emitted by `wrapFailedDocMentions`
        // around tokens the runtime couldn't snapshot. Gate detection on
        // (a) the message actually carrying failedMentions metadata, so a
        // user-typed `[anything](#doc-failed?reason=missing)` in a web-source
        // message cannot spoof a system-rendered failure chip (round-2
        // review), and (b) the href parsing successfully to a known reason
        // — anything else falls through to the regular `<a>` rendering and
        // click-to-preview path. `void props` keeps the unused-vars rule
        // happy without splattering anchor-only attributes onto a non-anchor.
        if (typeof href === "string" && failedDocMentions && failedDocMentions.size > 0) {
          const failedReason = parseFailedDocHref(href);
          if (failedReason) {
            void props;
            return (
              <span
                title={failedDocReasonTooltip(failedReason)}
                data-doc-failed-reason={failedReason}
                style={{
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                  background: "var(--bg-sunken)",
                  color: "var(--fg-3)",
                  borderRadius: "var(--radius-input)",
                  padding: "0 var(--sp-1)",
                  border: "var(--hairline) dashed var(--border)",
                  cursor: "not-allowed",
                  fontSize: "0.9em",
                }}
              >
                {children}
              </span>
            );
          }
        }
        // Doc-preview links are `attachment:<id>` (the runtime rewrites a
        // captured mention into one). issue 831: a link whose href is neither a
        // doc-preview attachment nor a navigable web URL (e.g. an agent-written
        // worktree path) has no route on the cloud origin and 404s when
        // clicked — render its text as plain text instead of a dead link.
        const attachmentId = typeof href === "string" ? attachmentIdFromHref(href) : null;
        if (!attachmentId && !isNavigableWebHref(href)) {
          return <>{children}</>;
        }
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

          const clickedAttachmentId = attachmentIdFromHref(href);
          if (!clickedAttachmentId) return;

          event.preventDefault();
          // Seed the drawer's React Query ref cache (keyed by attachmentId) with
          // EVERY doc ref this message carries — so the drawer opens
          // synchronously and an in-doc cross-link to a sibling doc in the same
          // message hits cache too. The drawer fetches the bytes on demand from
          // `GET /attachments/:id`.
          const messageRefs = [...docAttachmentRefs.values()];
          for (const ref of messageRefs) {
            queryClient.setQueryData(docAttachmentRefQueryKey(ref.attachmentId), ref);
          }
          // Also seed the FULL per-message ref list under its own key so the
          // drawer can enumerate same-message siblings on the seeded path
          // (relative `other.md` links) without re-fetching the messages window.
          queryClient.setQueryData(docMessageAttachmentRefsQueryKey(msg.id), messageRefs);
          const next = new URLSearchParams(searchParams);
          next.set("docChat", msg.chatId);
          next.set("docMsg", msg.id);
          next.set("docAttachment", clickedAttachmentId);
          setSearchParams(next);
        };

        return (
          <a {...props} href={href} onClick={onClick} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [docAttachmentRefs, failedDocMentions, msg.chatId, msg.id, queryClient, searchParams, setSearchParams],
  );

  return (
    <div
      className="text-body"
      style={{
        color: "var(--fg)",
        marginTop: 2,
      }}
    >
      {msg.format === "file" && isImageBatchRefContent(msg.content) ? (
        <ImageBatchFromRef
          content={msg.content}
          markdownComponents={markdownComponents}
          rehypePlugins={messageRehypePlugins}
        />
      ) : msg.format === "file" && isInlineImageContent(msg.content) ? (
        <img
          src={`data:${msg.content.mimeType};base64,${msg.content.data}`}
          alt={msg.content.filename ?? "image"}
          style={{ maxWidth: 320, borderRadius: "var(--radius-panel)", marginTop: 4 }}
        />
      ) : msg.format === "file" && isImageRefContent(msg.content) ? (
        <ImageFromRef content={msg.content} />
      ) : msg.format === "text" || msg.format === "markdown" || msg.format === "request" ? (
        // A `request` ("ask") renders as a normal message — just its markdown
        // body. The answering surface is the AskTakeover overlay; the timeline
        // carries no separate card / status-label chrome for it.
        <MessageMarkdown components={markdownComponents} rehypePlugins={messageRehypePlugins}>
          {textContent ?? ""}
        </MessageMarkdown>
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
  );
}, areMessageBodyPropsEqual);

const MessageRow = memo(function MessageRow({
  msg,
  myAgentId,
  agentNameFn,
  agentAvatarFn,
  agentColorTokenFn,
  mentionParticipants,
}: MessageRowProps) {
  // GitHub-dispatcher cards keep the human-agent uuid in `senderId` so
  // routing / read-receipts / mention-resolution stay consistent, but we
  // re-attribute the row to a synthetic "GitHub" sender in the UI. The
  // gate is conjunctive (`source` + `format` + content shape + metadata
  // marker) because `sendMessageSchema` accepts arbitrary metadata — a
  // metadata-only check would let any agent spoof a "from GitHub" card by
  // posting plain text with the marker set. `isSelf` is also overridden
  // so the recipient does not see their own name color treatment on a
  // card the dispatcher wrote on their row.
  const isGithubSystem = isTrustedGithubDispatcherMessage(msg);
  const senderName = isGithubSystem ? GITHUB_SYSTEM_SENDER_NAME : agentNameFn(msg.senderId);
  const isSelf = !isGithubSystem && myAgentId === msg.senderId;

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
      {isGithubSystem ? (
        <GithubSystemAvatar size={20} />
      ) : (
        <AgentHovercard
          agentId={msg.senderId}
          chatId={msg.chatId}
          name={senderName}
          placement="right"
          triggerClassName="block cursor-pointer self-start rounded-full"
        >
          <Avatar
            name={senderName}
            imageUrl={agentAvatarFn(msg.senderId)}
            seed={msg.senderId}
            colorToken={agentColorTokenFn(msg.senderId)}
          />
        </AgentHovercard>
      )}
      <div className="min-w-0">
        <div className="flex items-baseline" style={{ gap: 8 }}>
          {isGithubSystem ? (
            <span className="mono text-body font-semibold" style={{ color: isSelf ? "var(--fg)" : "var(--primary)" }}>
              {senderName}
            </span>
          ) : (
            <AgentHovercard
              agentId={msg.senderId}
              chatId={msg.chatId}
              name={senderName}
              placement="bottom"
              triggerClassName="cursor-pointer hover:underline"
            >
              <span className="mono text-body font-semibold" style={{ color: isSelf ? "var(--fg)" : "var(--primary)" }}>
                {senderName}
              </span>
            </AgentHovercard>
          )}
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            {formatClockTime(msg.createdAt)}
          </span>
          <span style={{ marginLeft: "auto" }}>
            <ReadReceipt msg={msg} myAgentId={myAgentId} />
          </span>
        </div>
        <MessageBody msg={msg} myAgentId={myAgentId} mentionParticipants={mentionParticipants} />
      </div>
    </div>
  );
}, areMessageRowPropsEqual);

function areMessageRowPropsEqual(prev: MessageRowProps, next: MessageRowProps): boolean {
  return (
    messageRenderFieldsEqual(prev.msg, next.msg) &&
    prev.myAgentId === next.myAgentId &&
    prev.agentNameFn === next.agentNameFn &&
    prev.agentAvatarFn === next.agentAvatarFn &&
    prev.agentColorTokenFn === next.agentColorTokenFn &&
    mentionParticipantsEqual(prev.mentionParticipants, next.mentionParticipants)
  );
}

function areMessageBodyPropsEqual(prev: MessageBodyProps, next: MessageBodyProps): boolean {
  return (
    messageBodyFieldsEqual(prev.msg, next.msg) &&
    prev.myAgentId === next.myAgentId &&
    mentionParticipantsEqual(prev.mentionParticipants, next.mentionParticipants)
  );
}

function messageRenderFieldsEqual(a: MessageWithDelivery, b: MessageWithDelivery): boolean {
  return (
    messageBodyFieldsEqual(a, b) &&
    a.createdAt === b.createdAt &&
    (a.deliveryStatus ?? null) === (b.deliveryStatus ?? null)
  );
}

function messageBodyFieldsEqual(a: MessageWithDelivery, b: MessageWithDelivery): boolean {
  return (
    a.id === b.id &&
    a.chatId === b.chatId &&
    a.senderId === b.senderId &&
    a.format === b.format &&
    a.source === b.source &&
    a.inReplyTo === b.inReplyTo &&
    jsonLikeEqual(a.content, b.content) &&
    jsonLikeEqual(a.metadata, b.metadata)
  );
}

function mentionParticipantsEqual(a: readonly MentionParticipant[], b: readonly MentionParticipant[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.agentId !== right.agentId || left.name !== right.name) return false;
  }
  return true;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonLikeEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonLikeEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (!isJsonRecord(a) || !isJsonRecord(b)) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    if (!key || key !== bKeys[i]) return false;
    if (!jsonLikeEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * For snapshot-variant `documentContext`, return a map from the agent's
 * written raw token (suffix-stripped — wire format) to the failure reason.
 * Empty / absent variants return undefined so callers can short-circuit the
 * wrapping pass.
 */
export function failedDocMentionsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): Map<string, DocSnapshotFailReason> | undefined {
  const parsed = documentContextSchema.safeParse(metadata?.documentContext);
  if (!parsed.success || parsed.data.kind !== "snapshot") return undefined;
  const failed = parsed.data.failedMentions;
  if (!failed || failed.length === 0) return undefined;
  const map = new Map<string, DocSnapshotFailReason>();
  for (const entry of failed) map.set(entry.raw, entry.reason);
  return map;
}

/**
 * User-facing tooltip text for an inert-chip reason. Kept in this file (not
 * the shared lib) because copy lives with the surface that renders it.
 */
function failedDocReasonTooltip(reason: DocSnapshotFailReason): string {
  switch (reason) {
    case "missing":
      return "文档不存在";
    case "out-of-fence":
      return "文档不在当前工作区";
    case "hidden-segment":
      return "路径包含受限段";
    case "too-large":
      return "文档超过预览大小限制";
    case "budget-exceeded":
      return "本条消息引用文档过多";
    case "unreadable":
      return "无法读取该文档";
  }
}

/**
 * React Query key for a doc `AttachmentRef`, keyed solely by attachmentId (the
 * blob is immutable, so the id is a stable cache key independent of which
 * message referenced it). The chat-view click handler seeds the ref here so the
 * drawer can read filename / sha256 / source.path without re-deriving them.
 */
export function docAttachmentRefQueryKey(attachmentId: string): readonly unknown[] {
  return ["chat-doc-attachment-ref", attachmentId] as const;
}

/**
 * React Query key for the FULL list of doc `AttachmentRef`s a single message
 * carries, keyed by messageId. The chat-view click handler seeds this so the
 * drawer can enumerate same-message sibling docs (relative `other.md` links)
 * on the seeded (no-fetch) path — `docAttachmentRefQueryKey` alone is keyed by
 * attachmentId and can't be enumerated. The cold-load / deep-link path falls
 * back to recovering the list from the chat's messages window.
 */
export function docMessageAttachmentRefsQueryKey(msgId: string): readonly unknown[] {
  return ["chat-doc-message-attachment-refs", msgId] as const;
}

function isInlineImageContent(content: unknown): content is FileMessageContent {
  if (typeof content !== "object" || content === null) return false;
  const c = content as Record<string, unknown>;
  return typeof c.data === "string" && typeof c.mimeType === "string" && (c.mimeType as string).startsWith("image/");
}

/**
 * Render an image referenced by `{imageId}`. The per-browser IndexedDB cache
 * is consulted first (sender's own sends warm it on send); on a miss the bytes
 * are fetched from the org attachment store and the cache is warmed for next
 * time. Only a failed fetch (deleted attachment / network) falls through to
 * the placeholder.
 */
function ImageFromRef({ content }: { content: ImageRefContent }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "hit"; src: string } | { kind: "miss" }>({
    kind: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hit = await getImage(content.imageId);
      if (cancelled) return;
      if (hit) {
        setState({ kind: "hit", src: `data:${hit.mimeType};base64,${hit.base64}` });
        return;
      }
      try {
        const fetched = await fetchAttachmentBase64(content.imageId);
        if (cancelled) return;
        // Warm the cache for subsequent renders; best-effort.
        putImage({ imageId: content.imageId, base64: fetched.base64, mimeType: fetched.mimeType }).catch(() => {});
        setState({ kind: "hit", src: `data:${fetched.mimeType};base64,${fetched.base64}` });
      } catch {
        if (!cancelled) setState({ kind: "miss" });
      }
    })();
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
        [Image "{content.filename}" failed to load]
      </span>
    );
  }
  return (
    <span className="text-label" style={{ color: "var(--fg-4)" }}>
      …
    </span>
  );
}

/**
 * Render a batched image message: optional caption rendered as markdown
 * (matching the regular text path so mention chips and links look the
 * same), followed by each attachment via {@link ImageFromRef}. One bubble
 * per send, regardless of how many images the user attached.
 */
function ImageBatchFromRef({
  content,
  markdownComponents,
  rehypePlugins,
}: {
  content: ImageBatchRefContent;
  markdownComponents: Components;
  rehypePlugins: MarkdownProps["rehypePlugins"];
}) {
  const caption = content.caption?.trim() ?? "";
  return (
    <div className="flex flex-col" style={{ gap: 4 }}>
      {caption.length > 0 ? (
        <Markdown components={markdownComponents} rehypePlugins={rehypePlugins}>
          {caption}
        </Markdown>
      ) : null}
      <div className="flex flex-wrap" style={{ gap: 6, marginTop: caption.length > 0 ? 2 : 0 }}>
        {content.attachments.map((att) => (
          <ImageFromRef key={att.imageId} content={att} />
        ))}
      </div>
    </div>
  );
}

type TimelineItem =
  | { kind: "message"; at: string; key: string; data: MessageWithDelivery }
  | { kind: "event"; at: string; key: string; data: SessionEventRow }
  | { kind: "workgroup"; at: string; key: string; events: SessionEventRow[] };

type ChatTimelineProps = {
  itemCount: number;
  visibleItems: readonly TimelineItem[];
  hiddenByBlock: number;
  readOnly: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  defaultWorkgroupOpen: boolean;
  agentNameFn: (id: string) => string;
  agentAvatarFn: (id: string) => string | null;
  agentColorTokenFn: (id: string) => string | null;
  myAgentId: string | null;
  mentionParticipants: MentionParticipant[];
  dockRequestId: string | undefined;
  gapAfterMessageId: string | null;
  firstNewItemIdx: number;
  dividerRef: RefObject<HTMLDivElement | null>;
  pillCount: number;
  onPillClick: () => void;
};

const ChatTimeline = memo(function ChatTimeline({
  itemCount,
  visibleItems,
  hiddenByBlock,
  readOnly,
  scrollContainerRef,
  messagesEndRef,
  defaultWorkgroupOpen,
  agentNameFn,
  agentAvatarFn,
  agentColorTokenFn,
  myAgentId,
  mentionParticipants,
  dockRequestId,
  gapAfterMessageId,
  firstNewItemIdx,
  dividerRef,
  pillCount,
  onPillClick,
}: ChatTimelineProps) {
  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto" style={{ padding: "var(--sp-2_5) var(--sp-6)" }}>
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
            {visibleItems.flatMap((item, idx) => {
              let node: ReactNode = null;
              if (item.kind === "workgroup") {
                // Default to folded while chatDetail is still loading — opening
                // a group chat's card for one frame and then folding it after
                // chatDetail resolves is worse than under-opening direct chats
                // by the same one-frame window.
                node = (
                  <WorkingTurn
                    key={item.key}
                    events={item.events}
                    defaultOpen={defaultWorkgroupOpen}
                    agentNameFn={agentNameFn}
                    agentAvatarFn={agentAvatarFn}
                    agentColorTokenFn={agentColorTokenFn}
                  />
                );
              } else if (item.kind === "event") {
                const ev = item.data;
                switch (ev.kind) {
                  case "error":
                    node = <ErrorRow key={item.key} event={ev} agentNameFn={agentNameFn} />;
                    break;
                  default:
                    // assistant_text / tool_call / thinking are folded into
                    // the workgroup card above; turn_end is filtered upstream;
                    // anything else is dropped.
                    node = null;
                }
              } else {
                const msg = item.data;
                node = (
                  <MessageRow
                    key={item.key}
                    msg={msg}
                    myAgentId={myAgentId}
                    agentNameFn={agentNameFn}
                    agentAvatarFn={agentAvatarFn}
                    agentColorTokenFn={agentColorTokenFn}
                    mentionParticipants={mentionParticipants}
                  />
                );
              }
              // Insert the gap banner immediately after the last cached
              // message when there's a known break between cache and the
              // server window.
              const isGapAnchor = item.kind === "message" && item.data.id === gapAfterMessageId;
              // Insert the "New Messages" divider before the first item
              // whose message id is strictly newer than the current anchor
              // (snapshotted at chat-open; re-armed when the divider scrolls
              // past the viewport top — see the IntersectionObserver above).
              const showDivider = idx === firstNewItemIdx;
              const prelude = showDivider ? <UnreadDivider key="unread-divider" ref={dividerRef} /> : null;
              const epilogue =
                isGapAnchor && item.kind === "message" ? <HistoryGapBanner key={`gap-after-${item.data.id}`} /> : null;
              if (prelude || epilogue) {
                const out: ReactNode[] = [];
                if (prelude) out.push(prelude);
                out.push(node);
                if (epilogue) out.push(epilogue);
                return out;
              }
              return node;
            })}
            {/* Blocking truncation marker: the conversation past the question is
                hidden until I answer it above. Keeps the cut from reading as a
                load error / empty tail. */}
            {hiddenByBlock > 0 ? (
              <div
                className="mono text-caption"
                style={{ color: "var(--fg-4)", textAlign: "center", padding: "var(--sp-3) 0 var(--sp-1)" }}
              >
                {`Answer the question above to see ${hiddenByBlock} newer ${
                  hiddenByBlock === 1 ? "message" : "messages"
                }`}
              </div>
            ) : null}
          </div>
          <div ref={messagesEndRef} />
        </div>
      </div>
      {/* Floating "↓ N new messages" pill — surfaces whenever there are messages
          newer than the user's session high watermark. Own sends never trigger
          the pill because send paths pre-advance the watermark to the new
          message id. */}
      {pillCount > 0 && !dockRequestId ? <NewMessagesPill count={pillCount} onClick={onPillClick} /> : null}
    </div>
  );
});

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
  initialChatDetail,
  readOnly = false,
  titleFallback,
  joinAction,
  narrow = false,
  onShowConversations = null,
}: {
  agentId: string;
  chatId: string;
  /** Chat detail already fetched by the chat-id shell. Used to avoid an
   * immediate same-key refetch when ChatView mounts for the same chat. */
  initialChatDetail?: ChatDetail;
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
  /** Workspace shell is in narrow-viewport mode (<768). Two effects:
   *  (1) `onShowConversations` is non-null, so we render a hamburger in
   *  the chat header; (2) the right rail, when shown, renders as an
   *  absolute-positioned overlay over the chat instead of an inline
   *  shrink-0 column — at 375 px logical there isn't room for both. */
  narrow?: boolean;
  /** Non-null only in narrow mode. Invoking it summons the conversation-
   *  list overlay (which lives in `WorkspacePage`). */
  onShowConversations?: (() => void) | null;
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
  const { agentId: myAgentId, memberId: myMemberId, user } = useAuth();
  // Unsent draft text, cached per user + chat in browser-local storage so it
  // survives chat switches and reloads (ChatView is not remounted on switch).
  // Clearing the draft on send empties its stored entry.
  const [draft, setDraft] = useChatDraftText(user?.id ?? null, chatId);
  // Always-current chat id for async send rollbacks: a send that FAILS after
  // the user switched chats must restore its rejected text into the originating
  // chat, never the one now in view (the draft state is shared and ChatView
  // isn't remounted on switch).
  const chatIdRef = useRef(chatId);
  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);
  const [cursor, setCursor] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { pendingImages, addImages, removeImage, clearImages } = usePendingImages({
    onError: setUploadError,
    // Dismiss a stale upload error (e.g. "image too large") the moment the
    // user adds or removes an image — they're already fixing it.
    onChange: () => setUploadError(null),
  });
  // Right-rail visibility. Two-tier default:
  //   • If the user has ever toggled the rail, that stored preference wins
  //     and persists across chats (a global preference, not per-chat).
  //   • Otherwise (no stored preference) the rail auto-opens for chats that
  //     HAVE a description, so the running summary is visible by default;
  //     chats without a description stay collapsed for the full reading
  //     column. This default is applied below once `chatDetail` resolves.
  const storedSidebarPref = useRef<boolean | null>(loadSidebarOpen());
  const [showSidebar, setShowSidebar] = useState<boolean>(storedSidebarPref.current ?? false);
  // Persist only genuine user choices (toggle / dismiss / open), never the
  // transient doc-preview stash or the description-driven auto-open — those
  // must not masquerade as an explicit preference. `setSidebarByUser` writes
  // through to localStorage; system-driven changes use `setShowSidebar`.
  const setSidebarByUser = useCallback((open: boolean | ((v: boolean) => boolean)) => {
    setShowSidebar((prev) => {
      const next = typeof open === "function" ? open(prev) : open;
      storedSidebarPref.current = next;
      saveSidebarOpen(next);
      return next;
    });
  }, []);

  // Temporary, staging-only view filter: hide agent final-text mirrors. The
  // toggle renders only on non-prod channels (`finalTextToggleEnabled`), and
  // the filter is additionally gated on that flag so a stale localStorage
  // preference can never hide messages on prod. Default OFF (show everything).
  const serverChannel = useServerChannel();
  const finalTextToggleEnabled = serverChannel === "dev" || serverChannel === "staging";
  const [hideAgentFinalText, setHideAgentFinalText] = useState<boolean>(loadHideAgentFinalText);
  const toggleHideAgentFinalText = useCallback(() => {
    setHideAgentFinalText((prev) => {
      const next = !prev;
      saveHideAgentFinalText(next);
      return next;
    });
  }, []);
  const hideFinalTextActive = finalTextToggleEnabled && hideAgentFinalText;
  // The chat id the description-driven rail default was last applied for.
  // `ChatView` is NOT remounted on chat switch (the `chat-detail` query
  // just refetches by `chatId`), so this must be keyed by chat id — not a
  // one-shot boolean — or the default would only ever apply to the first
  // chat viewed in the session.
  const descriptionDefaultChatRef = useRef<string | null>(null);
  // Doc-preview opens to the right of chat-view (mounted at workspace level);
  // we render two right rails on the same row, so when the user clicks a doc
  // link we collapse this sidebar to give the preview the right slot it
  // expects. Stash whether the sidebar was visible at the moment doc-preview
  // opened so we can auto-restore it when the preview closes — the user did
  // not ask to dismiss the sidebar, they only opened a doc.
  const hasDocPreview = Boolean(searchParams.get("docChat") && searchParams.get("docAttachment"));
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
      next.delete("docMsg");
      // Current owner of which doc is open (attachment-ref model).
      next.delete("docAttachment");
      // Legacy params from the pre-convergence `docPath` model — still cleared
      // so a stale URL minted before the migration also clears cleanly.
      next.delete("docAgent");
      next.delete("docPath");
      next.delete("docBase");
      setSearchParams(next, { replace: true });
      sidebarBeforeDocPreviewRef.current = true;
      return;
    }
    setSidebarByUser((v) => !v);
  }, [hasDocPreview, searchParams, setSearchParams, setSidebarByUser]);
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
      setSidebarByUser(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hasDocPreview, showSidebar, setSidebarByUser]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // The composer footer band — wraps BOTH the request dock (with its option
  // radios) and the composer. The Enter-to-resolve backstop binds its keydown
  // listener here, not on `window`, so it only sees keys from inside the
  // composer/dock subtree: a portaled dialog (custom Select listbox, Radix
  // dialog) rendered over a still-mounted chat can't bubble Enter into it and
  // silently resolve the pinned question in the background.
  const composerFooterRef = useRef<HTMLDivElement | null>(null);
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
  const { scrollToBottomImmediate, scrollToMessageImmediate, scrollToBottom, scrollToMessage, isAtBottom } =
    useChatScroll(scrollContainerRef);

  // Auto-grow the composer up to the CSS `max-height` cap (10.5rem ≈ 8
  // visible lines). Same hook as the new-chat composer for a consistent
  // typing experience across both entry points.
  useAutoResizeTextarea(textareaRef, draft);
  /** Once-per-chat guard for the focus auto-prime: after the user has
   * focused the input even once, we don't keep slapping `@` back into an
   * empty draft. Reset when switching chats. */
  const focusPrimedRef = useRef(false);
  // Current-draft provenance for the single `@` inserted by focus auto-prime.
  // This is intentionally narrower than `focusPrimedRef`: the latter only
  // means auto-prime has ever happened in this chat, while this flag means the
  // current draft is still the untouched auto-prime token.
  const autoPrimedDraftRef = useRef(false);
  /** Once-per-session set of chatIds we've pre-filled. Set semantics
   * (not a single ref) so revisiting an empty chat we already touched
   * doesn't re-stamp the greeting on top of the user's cleared draft.
   * Persists for the life of the ChatView component. */
  const prefilledChatsRef = useRef<Set<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is intentionally chatId-scoped.
  useEffect(() => {
    focusPrimedRef.current = false;
    autoPrimedDraftRef.current = false;
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
  // FOLLOW-UP: this loads only the latest 50 messages (no pagination) and
  // the events query below only the primary agent's events. The status
  // surfaces' "jump to timeline" gates clickability on what's actually
  // mounted (useMountedAnchors), so older / non-primary-agent anchors
  // simply aren't clickable yet. Full jump coverage needs message
  // pagination + multi-agent event loading — tracked as a separate effort.
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

  // The viewer's open questions in this chat, fetched independently of the
  // capped 50-message timeline window above. The blocking answer UI unions
  // these into its derivation (`blockingMessages`) so an open ask that has
  // scrolled past the latest page still surfaces. Same 5s poll + WS
  // invalidation as the timeline; the query usually returns 0–1 rows.
  const { data: openRequestsData } = useQuery({
    queryKey: ["chat-open-requests", chatId],
    queryFn: () => listChatOpenRequests(chatId),
    refetchInterval: 5_000,
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
    initialData: initialChatDetail?.id === chatId ? initialChatDetail : undefined,
    staleTime: 10_000,
  });

  // Apply the description-driven right-rail default once per chat, after that
  // chat's `chatDetail` resolves — but only when the user has no stored
  // preference (otherwise their explicit choice is honored untouched). A chat
  // with a non-empty description auto-opens the rail so the summary is visible
  // by default; a chat without one collapses it (so a previous chat's transient
  // auto-open doesn't leak across navigation). This auto-open does NOT persist,
  // so only a later explicit toggle creates a sticky preference. While a
  // doc-preview owns the right rail we bail out WITHOUT marking the chat
  // applied — otherwise a chat entered via a doc-preview deep link would be
  // marked done while the open was skipped, and closing the preview (which
  // re-runs this effect via `hasDocPreview`) would hit the per-chat guard and
  // never apply the default. Leaving it unmarked lets the close re-evaluate.
  useEffect(() => {
    if (chatDetailLoading || !chatDetail || chatDetail.id !== chatId) return;
    if (descriptionDefaultChatRef.current === chatId) return;
    if (hasDocPreview) return;
    descriptionDefaultChatRef.current = chatId;
    if (storedSidebarPref.current !== null) return;
    const hasDescription = Boolean(chatDetail.description && chatDetail.description.trim().length > 0);
    setShowSidebar(hasDescription);
  }, [chatId, chatDetail, chatDetailLoading, hasDocPreview]);

  // Cumulative token usage for the whole chat (server SUM over token_usage
  // events). Polled on the same cadence as messages so the composer marker
  // catches up within a few seconds of a turn ending. Cheap aggregate query.
  const { data: chatTokenUsage } = useQuery({
    queryKey: ["chat-token-usage", chatId],
    queryFn: () => getChatTokenUsage(chatId),
    enabled: !!chatId,
    refetchInterval: 5_000,
  });
  const chatActiveTokens = chatTokenUsage ? chatTokenUsage.inputTokens + chatTokenUsage.outputTokens : 0;
  const chatProcessedTokens = chatTokenUsage ? chatActiveTokens + chatTokenUsage.cachedInputTokens : 0;

  /** Org-wide agent list, consumed by `managedByMeMap` for picker
   *  grouping and by the identity-map hooks (`useAgentIdentityMap` etc.)
   *  that drive chip / avatar rendering. The `@` autocomplete is
   *  membership-scoped (`mentionCandidates` below) and does NOT read
   *  from this list — inviting a new agent goes through the `[+]`
   *  button, which owns its own server-search via `useOrgAgentsSearch`
   *  (issue 494) and is therefore not capped at the 100-row first page.
   *
   *  Shared single React Query cache, one HTTP fetch per refetch tick.
   *  See issue 495. */
  const { data: orgAgentsPage } = useOrgAgents();

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
    (
      text: string,
      route?: { mentions?: string[]; inReplyTo?: string; resolves?: RequestResolution },
    ): MessageWithDelivery | null => {
      if (!myAgentId) return null;
      return {
        id: `optimistic-${crypto.randomUUID()}`,
        chatId,
        senderId: myAgentId,
        format: "text",
        content: text,
        // Stamp the routing/lifecycle metadata on the optimistic row so
        // `deriveRequestState` flips a just-answered request immediately —
        // the dock unpins and the card resolves without waiting for the
        // POST + refetch round-trip (otherwise the still-"open" question
        // invites a second resolve send on a slow link).
        metadata: {
          ...(route?.mentions && route.mentions.length > 0 ? { mentions: route.mentions } : {}),
          ...(route?.resolves ? { resolves: route.resolves } : {}),
        },
        inReplyTo: route?.inReplyTo ?? null,
        source: "web",
        createdAt: new Date().toISOString(),
        deliveryStatus: "pending",
      };
    },
    [chatId, myAgentId],
  );

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

  // Bundles the optimistic-insert + watermark pre-advance pair into
  // one call so every own-send entry point (text, image, text-after-
  // image, and any future variant like resend or forward) keeps the
  // invariant "the same render that adds an own optimistic row also
  // moves the watermark past it". Avoids the per-call-site copy that
  // a reviewer flagged as easy to skip when adding a new send path.
  const insertOwnOptimisticMessage = useCallback(
    (msg: MessageWithDelivery) => {
      insertOptimisticMessage(msg);
      setPendingHighWaterAdvance({ chatId, messageId: msg.id });
    },
    [insertOptimisticMessage, chatId],
  );

  const sendMut = useMutation({
    mutationFn: ({
      content,
      mentions,
      inReplyTo,
      resolves,
    }: {
      content: string;
      mentions: string[];
      inReplyTo?: string;
      resolves?: RequestResolution;
    }) =>
      // `resolves` rides the blocking question's answer send (option
      // selections + free text merged) — see the `dockRequest` branch in
      // handleSend. Plain sends keep the 3-arg shape (no opts on the wire).
      inReplyTo || resolves
        ? sendChatMessage(chatId, content, mentions, { inReplyTo, resolves })
        : sendChatMessage(chatId, content, mentions),
    // Optimistic insert: render the user's row above the composer immediately
    // and clear the draft so the input feels responsive even when the POST
    // round-trip + follow-up GET take 1–2s. The ctx returned here is threaded
    // to onError / onSuccess so we can reconcile with the server row.
    onMutate: async ({ content, mentions, inReplyTo, resolves }) => {
      await queryClient.cancelQueries({ queryKey: messagesQueryKey });
      const previousDraft = draft;
      setDraft("");
      const optimistic = buildOptimisticTextMessage(content, { mentions, inReplyTo, resolves });
      if (!optimistic) return { tempId: null, previousDraft, sendChatId: chatId };
      insertOwnOptimisticMessage(optimistic);
      return { tempId: optimistic.id, previousDraft, sendChatId: chatId };
    },
    onSuccess: (saved, _content, ctx) => {
      if (ctx?.tempId) replaceOptimisticMessage(ctx.tempId, saved);
      // Refresh the workspace sidebar the moment the message is durable —
      // server's predictive Step 1b (in services/message.ts) just upserted an
      // `active` agent_chat_sessions row, so the new chat now satisfies the
      // listAgentSessions INNER JOIN. Without this invalidate the user would
      // wait up to 10s for the polling refetch. See M plan Step 3 in
      // first-tree-context:agent-hub/messaging.md.
      queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(agentId) });
      // Persist the own-send advance to chat-A's read-state row
      // both in the React Query cache and in IndexedDB, keyed by
      // the `chatId` captured in this closure at send time. The
      // direct write makes the snapshot durable even if the user
      // switches chats before the tracker's debounce window
      // settles. The just-sent message is also the chat tip — so
      // `latestKnownMessageId = saved.id` is both the visual anchor
      // and the freshness marker.
      const ownSendReadState: ReadState = {
        chatId,
        bottomVisibleMessageId: saved.id,
        latestKnownMessageId: saved.id,
        updatedAt: Date.now(),
      };
      queryClient.setQueryData<ReadState>(["chat-read-state", chatId], ownSendReadState);
      void setReadState(chatId, saved.id, saved.id);
      // Pre-advance the in-memory high water to the new message id
      // BEFORE initiating the smooth scroll. By the time the new
      // message commits to `mergedMessages`, `sessionHighestIdx`
      // already resolves to the new last index → `pillCount = 0` →
      // pill never flashes for the user's own send.
      setPendingHighWaterAdvance({ chatId, messageId: saved.id });
      // When the user sends a message, scroll all the way to the
      // bottom so they see their own send. ResizeObserver-debounced
      // (non-immediate) variant so the scroll lands after the
      // newly-arrived message has been rendered. Without this,
      // M2's once-per-chat-visit gate would suppress any scroll
      // and the user's just-sent message would arrive off-screen.
      scrollToBottom("smooth");
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
      if (
        ctx?.previousDraft &&
        !parkFailedDraftIfSwitched(user?.id ?? null, ctx.sendChatId, chatIdRef.current, ctx.previousDraft)
      ) {
        setDraft((current) => (current === "" ? ctx.previousDraft : current));
      }
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
    if (uploading) return;

    // Answering a blocking question is owned by the AskTakeover overlay (it
    // covers the composer while a question blocks me), so the composer's send
    // path no longer resolves requests — it is reached only when nothing blocks.

    if (!text && images.length === 0) return;

    // No client-side unresolved-`@`-token pre-flight: a `@<token>` that
    // doesn't resolve to a chat member is treated as plain text, matching
    // Slack/Discord. This avoids false positives like npm scoped
    // package names (`@scope/pkg`) or quoted handles in the body. The
    // `enforceGroupMention` constraint (group chat must address at least
    // one member) is reflected via `requiresMention` + `draftMentions`
    // gating the send button below — `extractMentions` resolves only
    // against in-chat membership, so an `@<outsider>` simply contributes
    // nothing and the button stays disabled, prompting the user to use
    // the `[+]` button or the autocomplete picker.

    // Group-chat send guard: a multi-speaker chat has no no-recipient send
    // path — every message must @mention at least one member. The send button
    // is already disabled in this state (see `sendBlockedByMentionGate`), so
    // this is the Enter-key / programmatic backstop. Applies to image-only
    // sends too: the server's mention check runs per message regardless of
    // format, so an un-addressed image would 400 just like un-addressed text.
    // Surface a hint when the user has only attached images so the
    // silent-return doesn't look like a stuck send. A live dock lifts the
    // gate — `routedMentions` below defaults the recipient to the asker.
    if (sendBlockedByMentionGate) {
      if (images.length > 0) {
        // English matches the other uploadError strings in this file
        // (Failed to send image / Failed to add participants / Image too large).
        setUploadError("@mention a group member in the text — images will be addressed to the same recipient(s).");
      }
      return;
    }

    // Routing mentions for this send. While a dock is live, its asker is the
    // default recipient when no explicit @mention resolved — a typed/edited
    // reply is "for the asker to judge" (exactly what the dock's helper line
    // promises), and it then threads under the question via
    // `findThreadableRequestId` below. Explicit @mentions always win.
    const routedMentions =
      effectiveSendMentions.length === 0 && dockRequest ? [dockRequest.senderId] : effectiveSendMentions;

    // "Chat about this": a plain reply that addresses the agent which asked an
    // open question directed at me (explicit @mention, or the dock-asker
    // fallback above) threads under that question (`inReplyTo`) so the
    // back-and-forth stays scoped to it. Computed BEFORE the image branch —
    // a captioned image answering a docked question must thread exactly like
    // a text reply. This does NOT resolve the question — `inReplyTo` is pure
    // threading; resolution needs an explicit `metadata.resolves`, written only
    // by the target human's answer in the AskTakeover (an agent cannot resolve).
    const threadedRequestId = findThreadableRequestId(mergedMessages, myAgentId, routedMentions) ?? undefined;

    if (images.length > 0) {
      setUploading(true);
      setUploadError(null);
      // Carry the routing mentions onto each image message so the
      // server's explicit-recipient enforcement check accepts file-format sends.
      // `routedMentions` already includes the 1:1 peer (per the
      // explicit-only contract) or the dock-asker fallback, so the file path
      // works in DM, group, and docked-question chats — without this every
      // image POST would 400.
      const imageMetadata = routedMentions.length > 0 ? { mentions: routedMentions } : undefined;
      // Snapshot draft + clear inputs up front so the composer feels instant.
      // Optimistic rows render into the cache below; rollback restores both
      // the textarea draft and any not-yet-acked optimistic tempIds on error.
      const previousDraft = draft;
      const sendChatId = chatId;
      setDraft("");
      clearImages();
      await queryClient.cancelQueries({ queryKey: messagesQueryKey });
      const pendingTempIds = new Set<string>();
      try {
        // Track the latest server-returned message id so we can pre-advance
        // the high water in one shot after the send lands. See
        // `pendingHighWaterAdvance` for rationale.
        let lastSentMessageId: string | null = null;

        // Upload every image's bytes to the org attachment store first, then
        // build the ref-only batch body. The batched POST below sends caption
        // + all refs as a single `format: "file"` message, collapsing what
        // used to be N image messages + 1 trailing text message into one
        // bubble. Bytes never ride the message body any more.
        const optimisticRefs: ImageRefContent[] = [];
        for (const img of images) {
          const uploaded = await uploadImageAttachment(img.file);
          // Warm the per-browser cache so the sending tab renders its own
          // message instantly without re-downloading the bytes it just
          // uploaded. A failed cache write is non-fatal — the render path
          // falls back to fetching from the server.
          try {
            const data = await readFileAsBase64(img.file);
            await putImage({ imageId: uploaded.id, base64: data, mimeType: img.file.type });
          } catch {
            // Cache warm is best-effort; ignore IndexedDB quota / availability
            // failures and let the render path fetch from the server.
          }
          optimisticRefs.push({
            imageId: uploaded.id,
            mimeType: img.file.type,
            filename: img.file.name,
            size: img.file.size,
          });
        }

        let batchTempId: string | null = null;
        if (myAgentId) {
          const optimisticContent: ImageBatchRefContent = {
            ...(text ? { caption: text } : {}),
            attachments: optimisticRefs,
          };
          const optimistic: MessageWithDelivery = {
            id: `optimistic-${crypto.randomUUID()}`,
            chatId,
            senderId: myAgentId,
            format: "file",
            content: optimisticContent,
            metadata: imageMetadata ?? {},
            // Mirror the POST below: a captioned image answering a docked
            // question threads under it, optimistically too.
            inReplyTo: threadedRequestId ?? null,
            source: "web",
            createdAt: new Date().toISOString(),
            deliveryStatus: "pending",
          };
          batchTempId = optimistic.id;
          pendingTempIds.add(batchTempId);
          // Pre-advance the watermark before the batched POST resolves so
          // the pill never counts the optimistic file batch as new
          // (parallel to sendMut.onMutate's pre-advance for text).
          insertOwnOptimisticMessage(optimistic);
        }

        const saved = await sendFileMessageBatch(
          chatId,
          {
            ...(text ? { caption: text } : {}),
            attachments: optimisticRefs,
          },
          imageMetadata,
          threadedRequestId ? { inReplyTo: threadedRequestId } : undefined,
        );
        if (batchTempId) {
          replaceOptimisticMessage(batchTempId, saved);
          pendingTempIds.delete(batchTempId);
        }
        lastSentMessageId = saved.id;
        for (const img of images) {
          URL.revokeObjectURL(img.previewUrl);
        }
        // Mirror sendMut.onSettled: predictive session-activation only shows
        // up in the sidebar after we invalidate, otherwise the file-send path
        // for the first message in a new chat waits for 10s polling.
        queryClient.invalidateQueries({ queryKey: messagesQueryKey });
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
        // Roll back unacknowledged optimistic rows + restore the draft so the
        // user can retry. Already-acked rows have been swapped to real ids by
        // replaceOptimisticMessage and are no longer in pendingTempIds.
        removeOptimisticMessages(pendingTempIds);
        // Only restore the pre-send draft if the user hasn't already started
        // typing something new during the upload window (PR review
        // observation #1).
        if (
          previousDraft &&
          !parkFailedDraftIfSwitched(user?.id ?? null, sendChatId, chatIdRef.current, previousDraft)
        ) {
          setDraft((current) => (current === "" ? previousDraft : current));
        }
      } finally {
        setUploading(false);
      }
      return;
    }

    sendMut.mutate({
      content: text,
      mentions: routedMentions,
      inReplyTo: threadedRequestId,
    });
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
   * Second pass collapses an agent's adjacent `assistant_text` + `tool_call` +
   * `thinking` rows into a single `workgroup` entry — these become the inline
   * WorkingTurn (latest narration as the body, tool/thinking as a
   * de-emphasized process lane). A real message, an error, or an agent switch
   * flushes the current bucket, so each card stays single-agent and a turn's
   * result message lands as its own row.
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
    const sorted = Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Staging-only view filter applied at THE single source feeding the
    // timeline AND every read-state projection derived from it (pill,
    // high-water, divider, scroll anchor, useReadTracker's `messages`). Doing
    // it here — not just at the rendered `items` — keeps the DOM and those
    // projections from diverging: a hidden row has no DOM node, so it must
    // also be absent from pill/anchor math or it drives an un-clearable "N
    // new" pill. The IDB/server caches keep the full set, so toggling off
    // restores the rows; the read-tracker derives its writes from the visible
    // DOM (see use-read-tracker), so durable read-state stays coherent.
    return selectVisibleMessages(sorted, hideFinalTextActive);
  }, [cachedMessages, messagesData, hideFinalTextActive]);

  const gapAfterMessageId = useMemo<string | null>(
    () => findGapAfterMessageId(cachedMessages ?? [], messagesData?.items ?? []),
    [cachedMessages, messagesData],
  );

  // ── Blocking request: the OLDEST (FIFO) live open question directed at me.
  // It pins its questions + options directly above the composer, the timeline
  // hides every item after it, and the block lifts only once it resolves —
  // then the next-oldest unanswered question takes over. The timeline card for
  // this request suppresses its inline answer block so the answering surface
  // (dock options + composer) exists exactly once.
  //
  // Two decoupled answer channels, unified on send: option clicks set
  // `answerSelections` (kept here as state, NEVER written into the composer, so
  // a click only highlights the option and leaves typed text untouched), and
  // the composer holds free text only. Sending merges both into one canonical
  // reply that ALWAYS carries `metadata.resolves` (kind="answered") — clicking
  // an option or typing free text both resolve the question; there is no
  // separate "leave it open for the asker to judge" path on this surface.
  // Watchers never block — the read-only branch renders no composer.
  // `readRequestPayload` always yields an answer affordance (a well-formed
  // payload, or a free-text fallback for an absent / legacy / malformed one), so
  // `dockPayload` is non-null whenever `dockRequest` is set: every open request —
  // including ones written under the retired schema — stays answerable and its
  // red dot can be cleared.
  // Union the server's window-independent open requests with the loaded
  // timeline before deriving the block, so an open ask that scrolled past the
  // latest 50 messages still blocks. Dedup by id; the loaded message WINS over
  // the open-requests row (it may carry an optimistic resolving reply, or the
  // resolving reply itself, that lifts the block the instant the viewer answers).
  const blockingMessages = useMemo<MessageWithDelivery[]>(() => {
    const open = openRequestsData?.items ?? [];
    if (open.length === 0) return mergedMessages;
    const byId = new Map<string, MessageWithDelivery>();
    for (const r of open) byId.set(r.id, r);
    for (const m of mergedMessages) byId.set(m.id, m);
    return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [openRequestsData, mergedMessages]);
  const dockRequest = useMemo(
    () => (readOnly ? null : findBlockingRequest(blockingMessages, myAgentId)),
    [readOnly, blockingMessages, myAgentId],
  );
  const dockPayload = useMemo(() => (dockRequest ? readRequestPayload(dockRequest.metadata) : null), [dockRequest]);
  // The full-coverage ask card is active (and owns answering) iff a question
  // blocks me. Both Reply and Skip resolve the question (Skip sends a "skipped"
  // answer — see the `onSkip` handler), so the overlay clears the moment the
  // resolving reply lands; there is no "dismiss but keep it open" path.
  const askOverlayActive = dockRequest != null && dockPayload != null;
  const dockRequestId = askOverlayActive ? dockRequest.id : undefined;
  useEffect(() => {
    if (!dockRequestId || draft !== "@" || !autoPrimedDraftRef.current) return;
    // Real message data can arrive after an empty group composer already
    // focus-primed `@`; once the block appears, the asker is the default route.
    autoPrimedDraftRef.current = false;
    focusPrimedRef.current = false;
    setDraft("");
    setCursor(0);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el || el.value !== "") return;
      el.setSelectionRange(0, 0);
    });
  }, [dockRequestId, draft, setDraft]);
  // Reset the per-question answer state when the block moves to a DIFFERENT
  // request (the current one resolved, or a newer one became the oldest live
  // question). Selections always reset; the free-text draft is dropped only on
  // a question→question handoff so an answer typed for one question doesn't
  // bleed into the next — never when the block first appears (prev=null) or
  // fully clears (next=null), where the send mutation's onMutate already owns
  // the draft.
  // Answer state lives in the AskTakeover overlay (remounted per request via
  // `key`), so chat-view no longer resets per-question selections here.

  const items: TimelineItem[] = useMemo(() => {
    const rawEvents = eventsData?.items ?? [];
    const visibleEvents = filterEventsForTimeline(rawEvents);

    // Turn anchor: the seq of the last turn_end across all events (including
    // ones filterEventsForTimeline dropped). Every surviving transient event
    // has seq > lastTurnEndSeq, so the agent's current turn gets one stable,
    // remount-safe key that survives toolUseId dedupe (pending → final swaps).
    let lastTurnEndSeq = -1;
    for (const e of rawEvents) {
      if (e.kind === "turn_end" && e.seq > lastTurnEndSeq) lastTurnEndSeq = e.seq;
    }

    // Collapse each agent's surviving transient events into ONE workgroup.
    // filterEventsForTimeline already narrows them to that agent's current
    // (un-ended) turn, so one workgroup == one in-progress turn. We deliberately
    // do NOT split on interleaved chat messages: a message landing mid-turn must
    // not fracture the turn into duplicate "working" cards. Each workgroup is
    // anchored at its earliest event so it sorts into the timeline where the
    // turn began; messages and error rows keep their own chronological slots.
    //
    // mergedMessages (IDB cache ∪ server) feeds the timeline, not the raw server
    // window — otherwise cached messages outside the "last 50" window would
    // vanish on chat re-open until the server fetch lands. When the staging
    // hide toggle is active, mergedMessages is already the filtered visible set
    // (see its useMemo), so the timeline, pill, divider, and read-tracker all
    // share one source.
    const out: TimelineItem[] = mergedMessages.map((m) => ({
      kind: "message" as const,
      at: m.createdAt,
      key: `m-${m.id}`,
      data: m,
    }));

    const turnEventsByAgent = new Map<string, SessionEventRow[]>();
    for (const e of visibleEvents) {
      if (e.kind === "tool_call" || e.kind === "thinking" || e.kind === "assistant_text") {
        const existing = turnEventsByAgent.get(e.agentId);
        if (existing) existing.push(e);
        else turnEventsByAgent.set(e.agentId, [e]);
      } else {
        // error rows stay standalone and visible across turns.
        out.push({ kind: "event", at: e.createdAt, key: `e-${e.id}`, data: e });
      }
    }
    for (const [agentId, events] of turnEventsByAgent) {
      events.sort((a, b) => a.seq - b.seq);
      const first = events[0];
      if (!first) continue;
      out.push({ kind: "workgroup", at: first.createdAt, key: `wg-${lastTurnEndSeq}-${agentId}`, events });
    }

    out.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }, [mergedMessages, eventsData]);

  const itemCount = items.length;

  // Blocking truncation: while a question blocks me (the FIFO-oldest live
  // request directed at me), hide every timeline item AFTER that request's
  // card — the conversation does not continue until I answer. The block is
  // viewer-local (`dockRequestId` is undefined for watchers / non-targets and
  // in the read-only view), so everyone else keeps the full timeline. If the
  // blocking request isn't in the loaded window (cutoff === -1) we don't
  // truncate — there's nothing to anchor on, and the dock still pins the
  // answer surface.
  const visibleItems = useMemo<TimelineItem[]>(() => {
    if (!dockRequestId) return items;
    const cutoff = items.findIndex((it) => it.kind === "message" && it.data.id === dockRequestId);
    return cutoff === -1 ? items : items.slice(0, cutoff + 1);
  }, [items, dockRequestId]);
  const hiddenByBlock = itemCount - visibleItems.length;

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
  // Tracks which chatId we have already snapshotted the divider
  // anchor for. Without this guard, the snapshot would re-fire on
  // every tracker IDB write (each one updates the React Query
  // cache for the chat-read-state key) and the anchor would slide
  // forward — defeating the "frozen at open" intent.
  const dividerSnapshotChatIdRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the trigger; setters are stable.
  useLayoutEffect(() => {
    setDividerAnchorMessageId(null);
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

  // Pill count = NON-SELF messages strictly newer than the effective
  // high watermark. Own sends never contribute even if the pre-advance
  // hasn't drained yet (e.g. the optimistic→saved replace step
  // briefly invalidates `sessionHighestId` between renders) — the
  // pill is semantically "remote arrivals you haven't seen", not
  // "anything past the watermark".
  const pillCount = useMemo<number>(() => {
    if (mergedMessages.length === 0) return 0;
    if (sessionHighestIdx < 0) return 0;
    let count = 0;
    for (let i = sessionHighestIdx + 1; i < mergedMessages.length; i++) {
      const msg = mergedMessages[i];
      if (!msg) continue;
      if (myAgentId && msg.senderId === myAgentId) continue;
      count++;
    }
    return count;
  }, [mergedMessages, sessionHighestIdx, myAgentId]);

  // Index of the first NON-SELF message strictly newer than the
  // snapshotted anchor — i.e., where the "New Messages" line slots
  // in. Own sends are skipped so the divider only marks the boundary
  // between "what I had seen" and "what arrived from someone else".
  // Without this skip, the user's own optimistic row (which is also
  // an `idx > unreadAnchorIdx` message) would re-trigger the divider
  // immediately after the user sends, which is not the intent.
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
  // has aged out of the window, or no newer non-self messages).
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
      if (idx === undefined || idx <= unreadAnchorIdx) continue;
      if (myAgentId && item.data.senderId === myAgentId) continue;
      return i;
    }
    return -1;
  }, [items, mergedMessages, unreadAnchorIdx, myAgentId]);

  // Re-arm semantics: when the divider scrolls past the viewport
  // top, advance `dividerAnchorMessageId` to what the user has
  // actually reached. The next render then has `firstNewItemIdx`
  // fall back to -1 for messages they've already passed — the
  // divider unmounts naturally (no jitter / reflow mid-list, since
  // it was already off-screen). Any subsequent NON-SELF arrival
  // strictly newer than the new anchor re-renders the divider at
  // the right slot. The divider is a recurring marker, not a
  // one-shot ribbon — dismissal is encoded entirely in the anchor.
  //
  // Latest `mergedMessages` / `liveBottomVisibleId` are read through
  // refs so the observer only rebuilds when the divider's mount
  // state flips (`firstNewItemIdx` crossing -1). Otherwise every
  // poll-driven message append and every sub-frame scroll tick
  // would disconnect + recreate the IntersectionObserver. Reviewer
  // R3 on PR 652.
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const liveBottomVisibleIdRef = useRef<string | null>(liveBottomVisibleId);
  const mergedMessagesRef = useRef<readonly MessageWithDelivery[]>(mergedMessages);
  useEffect(() => {
    liveBottomVisibleIdRef.current = liveBottomVisibleId;
  }, [liveBottomVisibleId]);
  useEffect(() => {
    mergedMessagesRef.current = mergedMessages;
  }, [mergedMessages]);
  useEffect(() => {
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
            // Advance the anchor to what the user has ACTUALLY
            // reached (live bottom-visible), NOT the chat tip. When
            // a batch of remote messages is taller than the
            // viewport, the divider can scroll past the top while
            // the user has only reached part-way down the batch —
            // anchoring at the tip would mark the still-below-the-
            // fold messages as already seen, suppressing both the
            // divider and `pillCount` for them. The live bottom-
            // visible message id is the boundary between "I have
            // seen this" and "still below the fold" at the moment
            // of dismissal. Codex P2 review on PR 652.
            //
            // Race guard: if the live bottom-visible is currently
            // an `optimistic-*` row (user scrolled to it during a
            // mid-flight own send) we skip it and walk back to the
            // last server-acked id. Without this guard, the
            // optimistic id gets replaced by the saved id moments
            // later → `unreadAnchorIdx = findIndex(...) = -1` →
            // `firstNewItemIdx` permanently falls through to -1 for
            // the rest of the visit, silently killing the divider
            // until the user switches chats. Reviewer R4 on PR 652.
            //
            // Fallback to the chat tip only when nothing usable is
            // available (very first paint, before the tracker has
            // emitted a bottom-visible). `firstNewItemIdx`
            // transiently stays -1 until the tracker catches up; no
            // harmful flash.
            const live = liveBottomVisibleIdRef.current;
            const msgs = mergedMessagesRef.current;
            let reached: string | null = live && !live.startsWith("optimistic-") ? live : null;
            if (!reached) {
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (m && !m.id.startsWith("optimistic-")) {
                  reached = m.id;
                  break;
                }
              }
            }
            setDividerAnchorMessageId(reached);
            return;
          }
        }
      },
      { root: container, threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [firstNewItemIdx]);

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
  // Each branch fires two scrolls:
  //   1. *Immediate — synchronous, lands the first paint at the
  //      current scrollHeight floor (no top-then-bottom flash).
  //   2. Non-immediate (ResizeObserver-debounced) — re-lands once
  //      the container's height has been stable for `stabilityDelay`
  //      (200 ms). `messagesData` and `eventsData` arrive in two
  //      independent React Query fetches, and messages typically
  //      land first; without this follow-up the immediate scroll
  //      lands at "messages end" and any in-progress `tool_call`
  //      workgroups arriving moments later end up below the fold
  //      (and `isAtBottom` flips to `false` as `scrollHeight` grows,
  //      so the streaming auto-follow effect below ALSO bails).
  //      The follow-up call is also why this useLayoutEffect doesn't
  //      need to wait for both queries — first paint stays correct,
  //      and the stable callback handles the late-arriving events.
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
  //  - baixiaohang manual report → on chat open the viewport landed
  //    at the last message's bottom, leaving in-progress tool_call
  //    workgroups (events that arrived after messages) below the
  //    fold. Added the stable follow-up scroll.
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
      scrollToMessage(bottomVisibleResolution.anchorId, "end", "auto");
    } else {
      // No prior snapshot (first-time visit, or the stored anchor
      // is gone): preserve the M1-era "open scrolls to bottom"
      // behavior.
      scrollToBottomImmediate("auto");
      scrollToBottom("auto");
    }
  }, [
    chatId,
    itemCount,
    bottomVisibleResolution,
    scrollToMessageImmediate,
    scrollToBottomImmediate,
    scrollToMessage,
    scrollToBottom,
  ]);

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
  // button (`AddParticipantDropdown` — owns its own search). Any
  // participant without a slug (`name`) is skipped — mentions need one.
  // Private agents in the chat surface here because membership, not
  // discovery, is the source of truth.
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

  // The `[+]` participant picker (chat header + right-sidebar) owns its
  // search input and fetches candidates directly via
  // `useOrgAgentsSearch`, so this view no longer composes a union of
  // chat participants + org-list for it. Pre-issue 494 the picker
  // sourced an in-memory list capped at 100 rows; the server-side search
  // model bypasses that cap, which is the whole point of issue 494.

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
    setDraft,
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
  // Shared participant projection: drives draftMentions resolution, the
  // composer's mirror-overlay highlight, and the sent-message rehype
  // plugin — keeping a single source of truth so the three paths can't
  // drift on case-sensitivity or filtering.
  const mentionParticipants = useMemo<MentionParticipant[]>(
    () => mentionCandidates.map((c) => ({ agentId: c.agentId, name: c.name })),
    [mentionCandidates],
  );
  // Rendered-message variant of the projection above: the rehype plugin
  // resolves `@<name>` tokens against this list, and it MUST include the
  // viewer themselves so chips that target them flip to the
  // `.mention-chip.is-self` attention tone. `mentionCandidates` deliberately
  // excludes self (the composer's `@` autocomplete should not suggest you
  // `@` yourself, and `draftMentions` / `MentionHighlightOverlay` keep
  // that self-exclusive semantics), so we append the viewer here in a
  // separate projection used only by rendered messages. Source the viewer's
  // slug from the speaker-only `chatParticipantById` map — NOT from the
  // org-identity fallback in `chatScopedAgentIdentity` — so a non-speaker
  // watcher viewing the chat doesn't get their org-wide name pushed into
  // the resolver, which would paint chips that the server would never
  // actually route to them.
  const renderMentionParticipants = useMemo<MentionParticipant[]>(() => {
    if (!myAgentId) return mentionParticipants;
    const selfParticipant = chatParticipantById.get(myAgentId);
    if (!selfParticipant?.name) return mentionParticipants;
    return [...mentionParticipants, { agentId: myAgentId, name: selfParticipant.name }];
  }, [mentionParticipants, myAgentId, chatParticipantById]);
  const draftMentions = useMemo(() => extractMentions(draft, mentionParticipants), [draft, mentionParticipants]);

  /**
   * Effective routing mentions sent to the server. The server enforces
   * explicit declaration (no more content-extraction fallback, no more
   * 1:1 implicit wake) — clients must put recipient uuids on the wire.
   *
   *   - In a 2-speaker chat: auto-inject the peer's uuid so a bare "hi"
   *     still reaches the recipient (the legacy 1:1 implicit-wake UX is
   *     reproduced by the client now that the server no longer fakes
   *     it).
   *   - In group chats: just the mentions the composer's chip set
   *     resolved. The send-button gate (`requiresMention &&
   *     draftMentions.length === 0`) already prevents sending with an
   *     empty mention set in groups, matching the server's
   *     explicit-recipient enforcement check.
   */
  const peerAgentId = useMemo<string | null>(() => {
    if (!chatDetail || !myAgentId) return null;
    const others = chatDetail.participants.filter((p) => p.agentId !== myAgentId);
    if (others.length === 1) {
      return others[0]?.agentId ?? null;
    }
    return null;
  }, [chatDetail, myAgentId]);
  const effectiveSendMentions = useMemo(
    () => (peerAgentId ? [...new Set([...draftMentions, peerAgentId])] : draftMentions),
    [draftMentions, peerAgentId],
  );

  // Group-chat mention gate, shared by the send button (disabled / title /
  // dimming) and handleSend's Enter-key backstop. A blocking question lifts the
  // gate: the pinned question makes its asker the default recipient, so no
  // typed @mention is required while a question blocks me.
  const sendBlockedByMentionGate = requiresMention && draftMentions.length === 0 && !askOverlayActive;

  // Unified send-disabled gate for the composer. While the AskTakeover overlay
  // is active it covers the composer (answering is owned there), so the composer
  // only ever sends ordinary messages: need text or an image, and (group chats)
  // an addressed @mention.
  const sendDisabled =
    sendMut.isPending || uploading || (!draft.trim() && pendingImages.length === 0) || sendBlockedByMentionGate;

  const mention = useMentionAutocomplete({
    value: draft,
    cursor,
    candidates: mentionCandidates,
    disabled: sendMut.isPending || uploading,
    onSelect: (update) => {
      autoPrimedDraftRef.current = false;
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

  /**
   * Slash-command setup. Per the design contract (`/ for commands` in the
   * placeholder), the popover follows the @mention context:
   *   - explicit @mention in the draft wins (most recent before cursor)
   *   - 1-on-1 chats (no required @) fall back to the sole other speaker
   *     so `/<cmd>` works without typing `@` first
   *   - group chats with no resolved @ show only system commands
   */
  const slashMentionContext = useMemo<{ agentId: string; displayName: string } | null>(() => {
    const explicit = resolveMentionContext(draft, cursor, mentionCandidates);
    if (explicit) return explicit;
    if (!requiresMention && mentionCandidates.length === 1) {
      const c = mentionCandidates[0];
      if (!c) return null;
      return { agentId: c.agentId, displayName: c.displayName ?? c.name ?? c.agentId };
    }
    return null;
  }, [draft, cursor, mentionCandidates, requiresMention]);

  // Phase 1C ships with a single in-product system command (`/clear`).
  // The four-command roadmap from the design doc (`/help`, `/me`,
  // `/invite`) needs its own UX surfaces (modals + invite flow), so it's
  // deferred to keep this PR scoped to the popover wiring. The
  // useSlashCommand hook expects an array, not an opinionated set —
  // adding the others is a one-line append once their actions exist.
  const slashSystemCommands = useMemo<SlashSystemCommand[]>(
    () => [{ kind: "system", name: "clear", description: "Clear the message draft" }],
    [],
  );

  const { data: slashSkillsData } = useQuery({
    queryKey: ["agent-skills", slashMentionContext?.agentId ?? null],
    queryFn: () => {
      const id = slashMentionContext?.agentId;
      if (!id) return Promise.resolve({ skills: [] });
      return getAgentSkills(id);
    },
    // Only fetch when we actually have a scope. Re-fetching on every
    // keystroke would amplify the GET — staleTime keeps the result for
    // a minute, which matches the daemon's "upload at start" cadence.
    enabled: Boolean(slashMentionContext?.agentId),
    staleTime: 60_000,
  });

  const slash = useSlashCommand({
    value: draft,
    cursor,
    systemCommands: slashSystemCommands,
    agentSkills: slashMentionContext
      ? {
          agentId: slashMentionContext.agentId,
          agentDisplayName: slashMentionContext.displayName,
          skills: slashSkillsData?.skills ?? [],
        }
      : null,
    mentionedAgent: slashMentionContext,
    disabled: sendMut.isPending || uploading,
    onSelect: (update, picked) => {
      autoPrimedDraftRef.current = false;
      setDraft(update.text);
      setCursor(update.cursor);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(update.cursor, update.cursor);
      });
      if (picked.kind === "system") {
        switch (picked.name) {
          case "clear":
            // `buildSlashInsert` already cleared the textarea content;
            // nothing else to do for v1.
            break;
        }
      }
      // Skill picks are not intercepted — the literal `/<name> ` is
      // already in the textarea so the user can append arguments and
      // send. The agent's harness routes the slash on receipt.
    },
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Chat body: left column owns header + timeline + composer; right
          rail (chat details) sits as an independent column when open.
          Putting the header inside the left column makes its reading-
          column centre share the same base as timeline/composer, so the
          title's left edge naturally aligns with the message avatars
          regardless of whether the right rail is open. `relative` is the
          anchor for the narrow-viewport overlay variants of the right
          rail and its scrim — no effect on wider viewports where both
          render as inline siblings. */}
      <div className="flex-1 flex overflow-hidden relative">
        <div
          className="flex-1 flex flex-col overflow-hidden min-w-0 relative"
          // While a blocking ask owns this chat, lift the center column above the
          // narrow-viewport right rail (an absolute `z-30` sibling + `z-20` scrim
          // anchored to the parent) so the takeover card is never occluded on
          // phone widths. No effect on wider viewports, where the rail is an
          // inline sibling and nothing overlaps. See QA defect: mobile rail over ask.
          style={askOverlayActive ? { zIndex: 40 } : undefined}
        >
          {/* The ask pops up as a card INSIDE the workspace body — offset below
              the (stable, single-row) topic header so the header and the
              right rail stay visible. Owns answering: Reply resolves with the
              composed answer; Skip ALSO resolves, sending a "skipped" answer so
              the asking agent unblocks and the red dot clears (skip is an answer,
              not a temporary dismiss). Keyed by request id so its answer state
              resets when the blocking question changes. */}
          {askOverlayActive && dockRequest && dockPayload ? (
            <div style={{ position: "absolute", top: 52, left: 0, right: 0, bottom: 0, zIndex: 30 }}>
              <AskTakeover
                key={dockRequest.id}
                body={typeof dockRequest.content === "string" ? dockRequest.content : ""}
                payload={dockPayload}
                askerName={chatScopedAgentName(dockRequest.senderId)}
                sending={sendMut.isPending}
                onReply={(content) =>
                  sendMut.mutate({
                    content,
                    mentions: [dockRequest.senderId],
                    inReplyTo: dockRequest.id,
                    resolves: { request: dockRequest.id, kind: "answered" },
                  })
                }
                onSkip={() =>
                  // Skip is an answer, not a dismiss: send a resolving reply
                  // (kind="answered") carrying a "skipped" body so the open
                  // request resolves, the red dot clears, and the asking agent
                  // unblocks and proceeds with its own judgment.
                  sendMut.mutate({
                    content: "(Skipped — no answer provided.)",
                    mentions: [dockRequest.senderId],
                    inReplyTo: dockRequest.id,
                    resolves: { request: dockRequest.id, kind: "answered" },
                  })
                }
              />
            </div>
          ) : null}
          {/* Chat header — content centred in a reading column that's now
          measured against the left column rather than the full panel.
          Title + EntityLink + ParticipantsStats live in the reading
          column; the chat-level icon strip (UserPlus / PanelRight)
          rides along at the column's right edge so it sits flush with
          the composer's right edge below. */}
          <div
            className="shrink-0 flex items-center"
            style={{
              // Min-height as a comfortable floor for a now-stable single-row
              // header: the topic sits on one line (truncating with an ellipsis
              // when long) and the description lives behind the ⓘ affordance, so
              // the header no longer grows with content. Vertical padding
              // centers that single row within the min-height.
              minHeight: 52,
              padding: "var(--sp-1_5) var(--sp-6)",
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
              {/* Narrow-viewport summon: header lost the brand cluster and
                  the conversation list collapsed out of the inline shell.
                  This hamburger is the only way to get back to the chat
                  list, so it sits at the very left of the chat header
                  (i.e. the visible left edge of the workspace). */}
              {onShowConversations ? (
                <button
                  type="button"
                  onClick={onShowConversations}
                  aria-label="Show conversations"
                  title="Show conversations"
                  className="inline-flex shrink-0 items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
                  style={{
                    width: 28,
                    height: 28,
                    border: 0,
                    background: "transparent",
                    borderRadius: "var(--radius-input)",
                    color: "var(--fg-3)",
                    cursor: "pointer",
                  }}
                >
                  <Menu size={16} strokeWidth={2.25} />
                </button>
              ) : null}
              {/* Identity — title is the sole click-to-rename affordance
              (Slack / Linear pattern). The hover-only ✏️ pencil was
              dropped after the title itself became clickable: two
              affordances for the same action add visual noise without
              improving discoverability. The per-agent `StateDot` was
              also dropped — in chat-first, runtime is a per-agent
              concept that belongs on each chip avatar (D-4), not on
              the chat header. */}
              {/* Title cluster — a stable single row: the topic leads in bold
                  (truncating with an ellipsis when it runs long), followed by
                  the optional GitHub entity link. The description text is not
                  rendered inline (it made the header height jitter with the
                  running summary and buried the topic) — it now lives in the
                  right rail's DescriptionSection. With the multi-line
                  description gone the row is naturally bounded, so the old
                  narrow-viewport `line-clamp-3` cap is no longer needed. */}
              <div className="flex min-w-0 items-center" style={{ flex: 1, gap: "var(--sp-1)" }}>
                {readOnly ? (
                  <span className="flex min-w-0 items-center" style={{ gap: "var(--sp-2)" }}>
                    <span className="truncate text-subtitle font-semibold" style={{ color: "var(--fg)" }}>
                      {chatDetail?.title ?? titleFallback ?? "…"}
                    </span>
                    <span
                      className="mono uppercase text-eyebrow shrink-0"
                      style={{
                        padding: "var(--hairline) var(--sp-1_25)",
                        borderRadius: 2,
                        color: "var(--fg-3)",
                        background: "var(--bg-sunken)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      watching
                    </span>
                  </span>
                ) : renaming ? (
                  <span className="inline-flex items-center" style={{ gap: "var(--sp-2)" }}>
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
                        // Narrower floor on phones — the desktop minimum plus
                        // the ✓/× buttons overflow a phone-width header row.
                        minWidth: narrow ? 120 : 200,
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
                      style={{ color: "var(--primary)", padding: 2 }}
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
                  </span>
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
                    className="min-w-0 truncate text-subtitle font-semibold text-left"
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
                {/* Chat description (running work summary) is NOT shown in the
                    header. It lives in the right rail's DescriptionSection
                    (rendered as markdown at the top of the rail), which
                    auto-opens for chats that have a description. The former
                    header ⓘ hover-card was removed as redundant with that
                    section. Read-only on the web — written by the owning agent
                    via `chat update --description`. */}
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
                onOpen={() => setSidebarByUser(true)}
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
                  onAdded={() => queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] })}
                />
              )}
              {/* Hide agent final-text toggle — TEMPORARY, staging/dev only
              (gated on `finalTextToggleEnabled`). Filters the per-turn
              final-text mirrors out of the timeline so a human watcher sees
              only deliberate sends + human messages. Eye / EyeOff conveys the
              show/hide state; pressed styling marks "currently hiding". */}
              {finalTextToggleEnabled && (
                <button
                  type="button"
                  onClick={toggleHideAgentFinalText}
                  aria-label={hideAgentFinalText ? "Show agent final messages" : "Hide agent final messages"}
                  aria-pressed={hideAgentFinalText}
                  title={hideAgentFinalText ? "Show agent final messages" : "Hide agent final messages"}
                  className="inline-flex shrink-0 items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
                  style={{
                    width: 28,
                    height: 28,
                    border: 0,
                    background: hideAgentFinalText ? "var(--bg-sunken)" : "transparent",
                    borderRadius: "var(--radius-input)",
                    color: hideAgentFinalText ? "var(--fg)" : "var(--fg-3)",
                    cursor: "pointer",
                  }}
                >
                  {hideAgentFinalText ? <EyeOff size={16} strokeWidth={2.25} /> : <Eye size={16} strokeWidth={2.25} />}
                </button>
              )}
              {/* Chat details toggle — opens the right rail (Participants /
              GitHub / Chat actions). Sits at the panel's far right,
              mirroring the rail's position. The PanelRight glyph is the
              panel-toggle convention (Linear / Notion / VS Code); the same
              glyph renders in both states — pressed styling (sunken
              background + darker foreground) carries the open/closed state.
              An ellipsis is reserved for overflow-action menus (see
              row-actions-menu.tsx), so it would mislead here. */}
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
                <PanelRight size={16} strokeWidth={2.25} />
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

          {/* Timeline region. Outer `relative flex-col` wrapper exists solely
          as the containing block for the floating pill — putting `position:
          relative` on the scroll container itself let the pill drift mid-list
          in some browsers (PR 286 manual sign-off rev 8). The wrapper sizes to
          the same bounds as the scroll viewport (single `flex-1` child + own
          `min-h-0`), so `absolute; bottom: var(--sp-3)` lands at the visible
          bottom of the chat panel regardless of scroll position.

          Scroll viewport stays full-width so the scrollbar hugs the panel's
          right edge — pushing it inward would float the column. Reading column
          inside is capped via `maxWidth` and centered to align with the
          composer below into one vertical thread. Side padding (sp-6) prevents
          content from kissing the panel border on narrow viewports. */}
          <ChatTimeline
            itemCount={itemCount}
            visibleItems={visibleItems}
            hiddenByBlock={hiddenByBlock}
            readOnly={readOnly}
            scrollContainerRef={scrollContainerRef}
            messagesEndRef={messagesEndRef}
            defaultWorkgroupOpen={chatDetail?.type === "direct"}
            agentNameFn={chatScopedAgentName}
            agentAvatarFn={agentAvatar}
            agentColorTokenFn={agentColorToken}
            myAgentId={myAgentId}
            mentionParticipants={renderMentionParticipants}
            dockRequestId={dockRequestId}
            gapAfterMessageId={gapAfterMessageId}
            firstNewItemIdx={firstNewItemIdx}
            dividerRef={dividerRef}
            pillCount={pillCount}
            onPillClick={onPillClick}
          />

          {/* Input. Outer band keeps full-width border-top + side padding so
          the composer separator continues the panel's edge-to-edge frame.
          Composer card inside is capped via `maxWidth` and centered, so it
          aligns vertically with the timeline column above — eye tracks
          from last message into textarea without a horizontal jump
          (Slack / ChatGPT / Linear DM all do this). On phones, the
          bottom padding extends past `env(safe-area-inset-bottom)` so
          the home-indicator doesn't overlap the send button. */}
          {
            <div
              ref={composerFooterRef}
              className="shrink-0"
              style={{
                padding: "var(--sp-2_5) var(--sp-6) calc(var(--sp-3) + env(safe-area-inset-bottom, 0))",
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
                      // Raised surface (`--bg-raised`) so the slot reads as a
                      // distinct input card lifted above the timeline (`--bg`),
                      // sharing the header chrome's surface. Mirrors the editable
                      // composer below so the read-only state shares its footprint.
                      background: "var(--bg-raised)",
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
                    {chatTokenUsage && chatProcessedTokens > 0 ? (
                      <div
                        className="mono text-caption"
                        style={{ color: "var(--fg-4)", padding: "0 var(--sp-0_5) var(--sp-1)" }}
                        title={`active ${chatActiveTokens.toLocaleString()} · input ${chatTokenUsage.inputTokens.toLocaleString()} · cached ${chatTokenUsage.cachedInputTokens.toLocaleString()} · output ${chatTokenUsage.outputTokens.toLocaleString()} · processed ${chatProcessedTokens.toLocaleString()}`}
                      >
                        {formatTokenCount(chatActiveTokens)} active tokens in this chat
                      </div>
                    ) : null}
                    <ComposeStatusBar
                      chatId={chatId}
                      agents={(chatDetail?.participants ?? []).filter((p) => p.type !== "human")}
                    />
                    {/* A blocking question is answered in the full-coverage
                        AskTakeover overlay (rendered over the workspace), not in
                        the composer. */}
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for image upload */}
                    <div
                      style={{
                        position: "relative",
                        border: "var(--hairline) solid var(--border)",
                        borderRadius: 6,
                        // Raised surface (`--bg-raised`) lifts the composer above
                        // the timeline (`--bg`) so it reads as a focused input card
                        // rather than blending into the page; the hairline border
                        // still defines its edge.
                        background: "var(--bg-raised)",
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
                        <SlashCommandPopover
                          trigger={slash.trigger}
                          results={slash.results}
                          highlightIndex={slash.highlightIndex}
                          mentionedAgent={slash.mentionedAgent}
                          anchorRef={textareaRef}
                          onPick={slash.pick}
                        />
                        {/* Mirror layer painting `@<participant>` chips behind
                          the textarea. Typography (`text-subtitle font-normal`)
                          is copied from the textarea's className so glyphs
                          align character-for-character; padding / sizing
                          must match the textarea's inline style below. */}
                        <MentionHighlightOverlay
                          value={draft}
                          participants={mentionParticipants}
                          textareaRef={textareaRef}
                          chipClassName="mention-text"
                          mirrorStyle={{
                            padding: "var(--sp-2_25) var(--sp-3) var(--sp-7_5)",
                            fontSize: "var(--text-subtitle)",
                            lineHeight: "var(--text-subtitle--line-height)",
                            letterSpacing: "var(--text-subtitle--letter-spacing)",
                            // Textarea is `font-normal` (400) which overrides
                            // the token's 600. Match it so character-width
                            // metrics line up with the textarea, otherwise
                            // chips would drift left of the textarea glyphs.
                            fontWeight: 400,
                            boxSizing: "border-box",
                          }}
                        />
                        <textarea
                          ref={textareaRef}
                          value={draft}
                          onChange={(e) => {
                            autoPrimedDraftRef.current = false;
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
                            // While a question is docked, priming is skipped — the
                            // asker is the default recipient (same gate that lifts
                            // `sendBlockedByMentionGate`), so stamping `@` would fight
                            // the dock contract as the user starts a free-text answer.
                            if (
                              !shouldPrimeMentionOnFocus({
                                requiresMention,
                                dockActive: dockRequest != null,
                                alreadyPrimed: focusPrimedRef.current,
                                draftLength: draft.length,
                                mentionCandidateCount: mentionCandidates.length,
                              })
                            ) {
                              return;
                            }
                            focusPrimedRef.current = true;
                            autoPrimedDraftRef.current = true;
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
                            // Slash command popover handles navigation keys when active.
                            // Sits before mention so `/`-typed draft never falls through to
                            // mention-autocomplete (the trigger predicates are disjoint, but
                            // ordering documents intent).
                            if (slash.handleKey(e)) return;
                            // Mention autocomplete gets next crack: when the caret is
                            // inside an active `@trigger` (typed, pasted, or pre-existing),
                            // Enter/Tab/Arrows/Escape drive the popover instead of
                            // sending or moving the cursor.
                            if (mention.handleKey(e)) return;
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleSend();
                            }
                          }}
                          disabled={sendMut.isPending || uploading}
                          className="mention-composer-textarea w-full outline-none text-subtitle font-normal"
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
                            // Text is rendered by `<MentionHighlightOverlay>`
                            // behind the textarea; here we only need to keep
                            // the caret and selection visible. `caretColor`
                            // restores the cursor that `color: transparent`
                            // would otherwise hide. Selection alpha picks up
                            // the browser's default highlight band, which
                            // remains visible over the overlay glyphs.
                            color: "transparent",
                            caretColor: "var(--fg)",
                            // The overlay is `position: absolute` and DOM-
                            // ordered before this textarea, so by default it
                            // paints in front of the textarea's static
                            // (caret) layer — which would hide the caret
                            // even though the text itself is transparent.
                            // Promoting the textarea to its own stacking
                            // context lifts the caret above the overlay.
                            position: "relative",
                            zIndex: 1,
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
                          // This toolbar sits inside the textarea's bottom-padding
                          // strip (`--sp-7_5`). The textarea above carries
                          // `zIndex: 1` (caret-over-overlay fix), which would
                          // otherwise hit-test ABOVE this z-auto row — the
                          // buttons stay visible through the textarea's
                          // transparent background but every click lands on the
                          // textarea instead (send/@/attach appear dead; only
                          // Enter works). Stack the toolbar higher so it gets
                          // pointer events back.
                          zIndex: 2,
                        }}
                      >
                        <span className="mono flex items-center" style={{ gap: 10 }}>
                          <button
                            type="button"
                            onClick={() => {
                              // Insert `@` at the cursor (or replace the current selection)
                              // and re-focus. The mention autocomplete will pick it up
                              // from the resulting `value`/`cursor` state — same path as
                              // typing `@` directly. Mirrors the Slack
                              // explicit-button affordance for users who don't know the
                              // keyboard trick.
                              const el = textareaRef.current;
                              if (!el) return;
                              const start = el.selectionStart ?? draft.length;
                              const end = el.selectionEnd ?? start;
                              const next = `${draft.slice(0, start)}@${draft.slice(end)}`;
                              autoPrimedDraftRef.current = false;
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
                            <span className="mono text-caption" style={{ color: "var(--primary)" }}>
                              uploading…
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={handleSend}
                            disabled={sendDisabled}
                            title={
                              sendBlockedByMentionGate
                                ? "@mention a member to send — a group message must address someone"
                                : "Send (Enter)"
                            }
                            aria-label="Send"
                            className={cn(
                              "inline-flex items-center justify-center transition-opacity",
                              sendDisabled && "opacity-40 cursor-not-allowed",
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
          }
        </div>
        {showSidebar ? (
          narrow ? (
            // Narrow viewport: rail floats over the chat instead of
            // pushing it aside. A scrim catches outside-clicks for
            // dismissal — Esc still works via the existing key handler
            // bound earlier in this component.
            <>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setSidebarByUser(false)}
                className="absolute inset-0 z-20"
                style={{ background: "var(--overlay-scrim)", border: 0, cursor: "default" }}
              />
              <div className="absolute top-0 bottom-0 right-0 z-30 flex" style={{ boxShadow: "var(--shadow-md)" }}>
                <ChatRightSidebar
                  chatId={chatId}
                  description={chatDetail?.description ?? null}
                  participants={chatDetail?.participants ?? []}
                  participantsLoading={chatDetailLoading}
                  managedByMe={managedByMeMap}
                  onAdded={() => queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] })}
                  readOnly={readOnly}
                  width="min(88vw, 20rem)"
                />
              </div>
            </>
          ) : (
            <ChatRightSidebar
              chatId={chatId}
              description={chatDetail?.description ?? null}
              participants={chatDetail?.participants ?? []}
              participantsLoading={chatDetailLoading}
              managedByMe={managedByMeMap}
              onAdded={() => queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] })}
              readOnly={readOnly}
            />
          )
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

  // Composite per-agent status for the dot, from the chat-level /agent-status
  // query — the same key the sidebar's AgentStatusPanel uses, so React Query
  // dedupes it to one request and the admin WS keeps it live (no per-avatar
  // poll). Humans have no runtime status. Rendered through the shared
  // viewOf / StatusGlyph vocabulary so the header strip and the sidebar agree.
  const { data: statuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    enabled: !isHuman,
    refetchInterval: 30_000,
  });
  const status = isHuman ? undefined : statuses?.find((s) => s.agentId === participant.agentId);
  const view = status ? viewOf(status.main) : null;
  const stateText = view ? view.label : isHuman ? "human" : "…";

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
      {view ? (
        <span aria-hidden="true" className="absolute" style={{ right: -1, bottom: -2 }}>
          <StatusGlyph
            colorVar={view.colorVar}
            shape={view.shape}
            pulse={view.pulse}
            size={8}
            ariaLabel={view.label}
            separator
          />
        </span>
      ) : null}
    </button>
  );
}
