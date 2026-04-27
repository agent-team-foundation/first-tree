import { extractMentions, type MentionParticipant } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare, Paperclip, Pause, Pencil, Send, Square, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
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
import {
  agentSessionsQueryKey,
  asAssistantTextPayload,
  asErrorPayload,
  asToolCallPayload,
  listAgentSessions,
  listSessionEvents,
  type SessionEventRow,
  type SessionListItem,
  type SessionMutationResponse,
  sessionQueryKey,
  suspendSession,
  terminateSession,
} from "../../../api/sessions.js";
import { useAuth } from "../../../auth/auth-context.js";
import { FirstTreeLogo } from "../../../components/first-tree-logo.js";
import {
  MentionAutocompletePopover,
  type MentionCandidate,
  useMentionAutocomplete,
} from "../../../components/mention-autocomplete.js";
import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { Markdown } from "../../../components/ui/markdown.js";
import { StateDot } from "../../../components/ui/state-dot.js";
import { useAgentIdentityMap, useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { cn } from "../../../lib/utils.js";
import { resolveAgentState } from "../../../utils/agent-state.js";
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

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
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

function SessionControls({
  agentId,
  chatId,
  session,
}: {
  agentId: string;
  chatId: string;
  session: SessionListItem | null;
}) {
  const queryClient = useQueryClient();
  const [, setSearchParams] = useSearchParams();
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminateError, setTerminateError] = useState<string | null>(null);

  const sessionKey = sessionQueryKey(agentId, chatId);
  const agentSessionsKey = agentSessionsQueryKey(agentId);

  const setSessionStateInCaches = (state: SessionListItem["state"]): void => {
    queryClient.setQueryData<SessionListItem>(sessionKey, (old) => (old ? { ...old, state } : old));
    queryClient.setQueryData<SessionListItem[]>(agentSessionsKey, (old) =>
      old ? old.map((s) => (s.chatId === chatId ? { ...s, state } : s)) : old,
    );
  };

  const suspendMut = useMutation<
    SessionMutationResponse,
    Error,
    void,
    { previousSession: SessionListItem | undefined; previousList: SessionListItem[] | undefined }
  >({
    mutationFn: () => suspendSession(agentId, chatId),
    onMutate: async () => {
      // Cancel both caches — the roster's 10s poller would otherwise clobber
      // the optimistic `suspended` flip mid-flight.
      await queryClient.cancelQueries({ queryKey: sessionKey });
      await queryClient.cancelQueries({ queryKey: agentSessionsKey });
      const previousSession = queryClient.getQueryData<SessionListItem>(sessionKey);
      const previousList = queryClient.getQueryData<SessionListItem[]>(agentSessionsKey);
      setSessionStateInCaches("suspended");
      return { previousSession, previousList };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previousSession) queryClient.setQueryData(sessionKey, ctx.previousSession);
      if (ctx?.previousList) queryClient.setQueryData(agentSessionsKey, ctx.previousList);
    },
    onSuccess: (res) => {
      setSessionStateInCaches(res.state);
    },
  });

  const terminateMut = useMutation<
    SessionMutationResponse,
    Error,
    void,
    { previousSession: SessionListItem | undefined; previousList: SessionListItem[] | undefined }
  >({
    mutationFn: () => terminateSession(agentId, chatId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: sessionKey });
      await queryClient.cancelQueries({ queryKey: agentSessionsKey });
      const previousSession = queryClient.getQueryData<SessionListItem>(sessionKey);
      const previousList = queryClient.getQueryData<SessionListItem[]>(agentSessionsKey);
      queryClient.setQueryData<SessionListItem[]>(agentSessionsKey, (old) =>
        old ? old.filter((s) => s.chatId !== chatId) : old,
      );
      return { previousSession, previousList };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previousSession) queryClient.setQueryData(sessionKey, ctx.previousSession);
      if (ctx?.previousList) queryClient.setQueryData(agentSessionsKey, ctx.previousList);
      setTerminateError(err instanceof Error ? err.message : "Terminate failed");
    },
    onSuccess: (res, _vars, ctx) => {
      // The admin API is lenient: a no-op response (e.g. the session was
      // reactivated between dialog-open and confirm) returns transitioned=false
      // with the current authoritative state. Only hide + navigate when the
      // row is actually gone.
      if (res.state !== "evicted") {
        if (ctx?.previousList) queryClient.setQueryData(agentSessionsKey, ctx.previousList);
        setSessionStateInCaches(res.state);
        setTerminateError(`Session is ${res.state}; terminate only applies to suspended sessions.`);
        return;
      }
      setTerminateError(null);
      setTerminateOpen(false);
      setSearchParams({ a: agentId });
    },
  });

  const isActive = session?.state === "active";
  const isSuspended = session?.state === "suspended";

  if (!isActive && !isSuspended) return null;

  return (
    <>
      <div
        className="inline-flex items-center"
        style={{
          gap: 4,
          padding: 4,
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          background: "var(--bg-sunken)",
        }}
      >
        {isActive && (
          <button
            type="button"
            onClick={() => suspendMut.mutate()}
            disabled={suspendMut.isPending}
            className="inline-flex items-center transition-colors text-label"
            style={{
              gap: 6,
              padding: "var(--sp-1) var(--sp-2_5)",
              color: "var(--fg-2)",
              borderRadius: "var(--radius-input)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <Pause className="h-3 w-3" /> Suspend
            <span className="kbd" style={{ marginLeft: 2 }}>
              ⌘⇧P
            </span>
          </button>
        )}
        {isSuspended && (
          <button
            type="button"
            onClick={() => {
              setTerminateError(null);
              setTerminateOpen(true);
            }}
            disabled={terminateMut.isPending}
            className="inline-flex items-center transition-colors text-label font-semibold"
            style={{
              gap: 6,
              padding: "var(--sp-1) var(--sp-2_5)",
              color: "var(--state-error)",
              background: "color-mix(in oklch, var(--state-error) 18%, transparent)",
              borderRadius: "var(--radius-input)",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "color-mix(in oklch, var(--state-error) 28%, transparent)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "color-mix(in oklch, var(--state-error) 18%, transparent)")
            }
          >
            <Square className="h-3 w-3" /> Terminate
          </button>
        )}
      </div>

      <TerminateSessionDialog
        open={terminateOpen}
        onOpenChange={(o) => {
          if (!terminateMut.isPending) setTerminateOpen(o);
          if (!o) setTerminateError(null);
        }}
        session={session}
        chatId={chatId}
        error={terminateError}
        pending={terminateMut.isPending}
        onConfirm={() => terminateMut.mutate()}
      />
    </>
  );
}

function TerminateSessionDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: SessionListItem | null;
  chatId: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const { open, onOpenChange, session, chatId, pending, error, onConfirm } = props;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!pending) onConfirm();
  }
  const shortId = chatId.slice(0, 8);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Terminate session?</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <p className="text-body text-muted-foreground">
            Ending this session is permanent. It is removed from the workspace and cannot be resumed. Chat history is
            preserved; a new message will start a fresh session.
          </p>
          <div
            className="mono text-label"
            style={{
              padding: "var(--sp-2) var(--sp-2_5)",
              borderRadius: "var(--radius-input)",
              background: "var(--bg-sunken)",
              border: "var(--hairline) solid var(--border)",
              color: "var(--fg-2)",
              display: "grid",
              gap: 4,
            }}
          >
            <span>
              chat: <span className="font-medium">{shortId}…</span>
            </span>
            {session?.lastActivityAt && <span>last activity: {formatRelative(session.lastActivityAt)}</span>}
            {typeof session?.messageCount === "number" && <span>messages: {session.messageCount}</span>}
          </div>
          {error && (
            <p className="mono text-label" style={{ color: "var(--state-error)" }}>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Terminating…" : "Terminate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

type PendingImage = {
  id: string;
  file: File;
  previewUrl: string;
};

type TimelineItem =
  | { kind: "message"; at: string; key: string; data: MessageWithDelivery }
  | { kind: "event"; at: string; key: string; data: SessionEventRow };

export function ChatView({ agentId, chatId }: { agentId: string; chatId: string }) {
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
  /** Once-per-chat guard for the focus auto-prime: after the user has
   * focused the input even once, we don't keep slapping `@` back into an
   * empty draft. Reset when switching chats. */
  const focusPrimedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is intentionally chatId-scoped.
  useEffect(() => {
    focusPrimedRef.current = false;
  }, [chatId]);

  const { data: messagesData } = useQuery({
    queryKey: ["chat-messages", chatId],
    queryFn: () => listChatMessages(chatId, { limit: 50 }),
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

  const { data: session } = useQuery({
    queryKey: sessionQueryKey(agentId, chatId),
    queryFn: () => listAgentSessions(agentId).then((sessions) => sessions.find((s) => s.chatId === chatId) ?? null),
    refetchInterval: 5_000,
  });

  const { data: chatDetail } = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    enabled: !!chatId,
  });

  const sendMut = useMutation({
    mutationFn: (content: string) => sendChatMessage(chatId, content),
    onSuccess: () => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["chat-messages", chatId] });
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

    if (images.length > 0) {
      setUploading(true);
      setUploadError(null);
      try {
        for (const img of images) {
          const data = await readFileAsBase64(img.file);
          const imageId = crypto.randomUUID();
          // Write to IndexedDB before the POST so the sending tab can render
          // its own message via the imageRef shape immediately on refetch,
          // even if the server write races ahead of the response.
          await putImage({ imageId, base64: data, mimeType: img.file.type });
          await sendFileMessage(chatId, {
            data,
            mimeType: img.file.type,
            filename: img.file.name,
            size: img.file.size,
            imageId,
          });
          URL.revokeObjectURL(img.previewUrl);
        }
        setPendingImages([]);
        if (text) await sendChatMessage(chatId, text);
        setDraft("");
        queryClient.invalidateQueries({ queryKey: ["chat-messages", chatId] });
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
  const items: TimelineItem[] = useMemo(() => {
    const msgs = messagesData?.items ?? [];
    const visibleEvents = filterEventsForTimeline(eventsData?.items ?? []);

    const out: TimelineItem[] = [
      ...msgs.map((m) => ({ kind: "message" as const, at: m.createdAt, key: `m-${m.id}`, data: m })),
      ...visibleEvents.map((e) => ({ kind: "event" as const, at: e.createdAt, key: `e-${e.id}`, data: e })),
    ];
    out.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }, [messagesData, eventsData]);

  const itemCount = items.length;
  useEffect(() => {
    if (itemCount > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [itemCount]);

  const participantsLabel = chatDetail?.participants
    ? chatDetail.participants
        .map((p) => {
          const name = agentName(p.agentId);
          return `@${name.length > 20 ? `${name.slice(0, 17)}…` : name}`;
        })
        .join(" ")
    : `@${agentName(agentId)}`;
  const displayName = agentName(agentId);

  // Mention autocomplete candidates — participants of this chat resolved to
  // their `{name, displayName}` via the shared identity map. Filter out
  // rows with no `name` since mentions need a slug target to insert. The
  // current viewer's own agent is also excluded so the picker never offers
  // self-mention (which the server filters anyway).
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const sourceIds = chatDetail?.participants?.map((p) => p.agentId) ?? [agentId];
    const out: MentionCandidate[] = [];
    for (const id of sourceIds) {
      if (id === myAgentId) continue;
      const ident = agentIdentity(id);
      if (!ident || !ident.name) continue;
      out.push({ agentId: id, name: ident.name, displayName: ident.displayName });
    }
    return out;
  }, [chatDetail?.participants, agentId, agentIdentity, myAgentId]);

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

  /** Local mirror of the server's mention resolution. Empty when nothing in
   * `draft` resolves to a participant — drives the send-button gate so we
   * don't hit the network with a request the server will 400. */
  const draftMentions = useMemo(() => {
    if (!requiresMention) return [];
    const ps: MentionParticipant[] = mentionCandidates.map((c) => ({ agentId: c.agentId, name: c.name }));
    return extractMentions(draft, ps);
  }, [draft, mentionCandidates, requiresMention]);

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
  const runtimeLabel = session?.runtimeState ?? "idle";
  const runtimeState = resolveAgentState(session?.runtimeState ?? null, agentId ? "connected" : null);
  const msgCount = session?.messageCount ?? messagesData?.items?.length ?? 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Chat header */}
      <div
        className="grid items-center shrink-0"
        style={{
          gridTemplateColumns: "1fr auto",
          gap: 10,
          padding: "var(--sp-2_5) var(--sp-3_5)",
          borderBottom: "var(--hairline) solid var(--border)",
        }}
      >
        <div className="min-w-0">
          <div className="flex items-center" style={{ gap: 8 }}>
            <StateDot state={runtimeState} size={8} />
            {renaming ? (
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
                  placeholder="Chat name"
                  className="outline-none text-subtitle"
                  style={{
                    flex: 1,
                    minWidth: 0,
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
              <>
                <span className="truncate text-subtitle" style={{ color: "var(--fg)" }}>
                  {chatDetail?.topic || session?.summary || `Chat · ${chatId.slice(0, 8)}`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setRenameDraft(chatDetail?.topic ?? "");
                    setRenaming(true);
                  }}
                  title="Rename chat"
                  className="inline-flex items-center transition-colors"
                  style={{ color: "var(--fg-4)", padding: 2 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-4)")}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </>
            )}
            <span
              className="mono text-caption"
              style={{
                color: "var(--fg-4)",
                padding: "var(--hairline) var(--sp-1_25)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-chip)",
              }}
            >
              {chatId}
            </span>
          </div>
          <div
            className="flex items-center text-caption"
            style={{
              color: "var(--fg-3)",
              marginTop: 4,
              gap: 10,
            }}
          >
            <span className="mono">{participantsLabel}</span>
            <span>·</span>
            <span>started {formatRelative(session?.startedAt ?? null)}</span>
            <span>·</span>
            <span>{msgCount} msgs</span>
            <span>·</span>
            <span>
              runtime{" "}
              <span
                className="mono"
                style={{
                  color:
                    runtimeState === "error"
                      ? "var(--state-error)"
                      : runtimeState === "working"
                        ? "var(--fg-2)"
                        : "var(--fg-2)",
                }}
              >
                {runtimeLabel}
              </span>
            </span>
          </div>
        </div>
        <SessionControls agentId={agentId} chatId={chatId} session={session ?? null} />
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto relative" style={{ padding: "var(--sp-2_5) var(--sp-3_5)" }}>
        {itemCount === 0 && (
          <div
            className="flex flex-col items-center text-body"
            style={{ color: "var(--fg-3)", padding: "var(--sp-8) 0", gap: 6 }}
          >
            <MessageSquare className="h-8 w-8" style={{ opacity: 0.3 }} />
            Send a message to start the conversation
          </div>
        )}
        <div className="flex flex-col" style={{ gap: 4 }}>
          {items.map((item) => {
            if (item.kind === "event") {
              const ev = item.data;
              switch (ev.kind) {
                case "tool_call":
                  return <ToolCallStatusRow key={item.key} event={ev} />;
                case "assistant_text":
                  return <AssistantTextRow key={item.key} event={ev} agentId={agentId} agentNameFn={agentName} />;
                case "thinking":
                  return <ThinkingRow key={item.key} event={ev} />;
                case "error":
                  return <ErrorRow key={item.key} event={ev} />;
                default:
                  // turn_end is filtered upstream; any unknown kind is dropped.
                  return null;
              }
            }
            return <TextRow key={item.key} msg={item.data} myAgentId={myAgentId} agentNameFn={agentName} />;
          })}
        </div>
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        className="shrink-0"
        style={{
          padding: "var(--sp-2_5) var(--sp-3_5)",
          borderTop: "var(--hairline) solid var(--border)",
        }}
      >
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
            <span className="mono flex items-center" style={{ gap: 8 }}>
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
              <span>/suspend</span>
              <span>/resume</span>
              <span>/branch</span>
              <span>/promote</span>
            </span>
            <span className="flex items-center" style={{ gap: 8 }}>
              {uploading && (
                <span className="mono text-caption" style={{ color: "var(--accent)" }}>
                  uploading…
                </span>
              )}
              <span>
                <span className="kbd">⏎</span> send <span className="kbd">⇧⏎</span> new line
              </span>
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
                    : undefined
                }
                className={cn(
                  "inline-flex items-center transition-colors text-label font-semibold",
                  (sendMut.isPending ||
                    uploading ||
                    (!draft.trim() && pendingImages.length === 0) ||
                    (requiresMention && draftMentions.length === 0)) &&
                    "opacity-50 cursor-not-allowed",
                )}
                style={{
                  gap: 6,
                  padding: "var(--sp-1) var(--sp-2_5)",
                  color: "oklch(0.14 0.01 150)",
                  background: "var(--accent)",
                  border: "var(--hairline) solid var(--accent)",
                  borderRadius: "var(--radius-input)",
                }}
              >
                <Send className="h-3 w-3" /> Send
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
      </div>
    </div>
  );
}
