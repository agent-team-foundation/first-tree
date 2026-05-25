import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname as getHostname, platform } from "node:os";
import {
  type AgentBindRejectReason,
  type AgentPinnedMessage,
  agentPinnedMessageSchema,
  type InboxDeliverFrame,
  imagePayloadFrameSchema,
  inboxDeliverFrameSchema,
  type RuntimeState,
  type ServerWelcomeFrame,
  type SessionEvent,
  type SessionState,
  serverWelcomeFrameSchema,
  type UpdateAttempt,
} from "@first-tree/shared";
import WebSocket from "ws";
import { createLogger, type pino } from "./observability/logger.js";
import { writeImage } from "./runtime/image-store.js";
import { type AccessTokenProvider, FirstTreeHubSDK } from "./sdk.js";

export type ClientConnectionConfig = {
  serverUrl: string;
  /** Stable per-machine client identifier. Generated if omitted. */
  clientId?: string;
  sdkVersion?: string;
  /**
   * Returns the current member access JWT. Called before the WS handshake
   * and before each bind so short-lived tokens refresh transparently. When
   * the server sends `auth:expired` the connection re-invokes this provider
   * after reconnecting.
   */
  getAccessToken: AccessTokenProvider;
  /**
   * Optional `User-Agent` string forwarded to every per-agent SDK created by
   * `agent:bound`. Distinct from `sdkVersion` (which is the value advertised
   * to the server in `client:register`); this one only decorates outbound
   * HTTP traffic so trace backends can identify the install. See SdkConfig.userAgent.
   */
  userAgent?: string;
  /**
   * Optional accessor for the most recent self-update outcome — the
   * command layer reads `~/.first-tree/hub/state/update-state.json` and
   * returns the parsed record. The connection forwards it on every
   * `client:register` so the server can persist into
   * `clients.metadata.lastUpdateAttempt`, giving the admin dashboard
   * visibility into clients that are failing to auto-update without
   * needing SSH access. Sync (the underlying read is a single small JSON
   * file) so the register frame can be built inline. The runtime
   * gracefully tolerates omission — clients without the update-state
   * wiring don't supply this, and the server's `clientRegisterSchema`
   * keeps the field optional.
   */
  getLastUpdateAttempt?: () => UpdateAttempt | null;
  /**
   * Override the heartbeat tick interval (default 30s). Lower values are
   * primarily useful in tests that need to exercise the silence watchdog or
   * proactive-refresh paths in sub-second budgets.
   */
  heartbeatIntervalMs?: number;
  /**
   * Override the silence watchdog timeout (default 90s — ~3 heartbeat ticks).
   * Surfaces wedged sockets (OS-suspend resume, silent network drops) that
   * leave readyState=OPEN but no bytes flowing. Test-friendly hook; the
   * production default already handles real-world drops fine.
   */
  heartbeatTimeoutMs?: number;
};

export type BoundAgent = {
  agentId: string;
  /**
   * Always populated post-Phase 2 of the agent-naming refactor — the
   * `agent:pinned` WebSocket frame resolves the label server-side.
   */
  displayName: string;
  agentType: string;
  sdk: FirstTreeHubSDK;
};

export type SessionCommand = {
  type: "session:suspend" | "session:terminate";
  agentId: string;
  chatId: string;
};

export type SessionReconcileResult = {
  agentId: string;
  staleChatIds: string[];
};

/**
 * Welcome frame received after `auth:ok`. `isReconnect` is true for every
 * occurrence after the first welcome in the lifetime of this `ClientConnection`
 * — lets consumers (UpdateManager) distinguish a cold-start install from a
 * reconnect into a newer Server.
 */
export type ServerWelcome = {
  frame: ServerWelcomeFrame;
  isReconnect: boolean;
};

type ClientConnectionEvents = {
  connected: [];
  disconnected: [];
  reconnecting: [attempt: number];
  reconnected: [];
  error: [error: Error];
  "agent:bound": [agent: BoundAgent];
  "agent:unbound": [agentId: string];
  /**
   * Server pushed a fully-assembled inbox entry over the WS data plane.
   * Listeners must call `connection.sendInboxAck(frame.entryId)` once the
   * entry has been durably handed to the session manager.
   */
  "inbox:deliver": [agentId: string, frame: InboxDeliverFrame];
  "agent:bind:rejected": [reason: AgentBindRejectReason, agentId: string];
  /**
   * Server announced that an agent has been pinned to this client (either
   * created with `clientId` or bound via PATCH NULL → ID). Consumers can use
   * this to auto-register the agent locally without a manual
   * `first-tree agent add`.
   */
  "agent:pinned": [message: AgentPinnedMessage];
  "session:command": [command: SessionCommand];
  "session:reconcile:result": [result: SessionReconcileResult];
  "auth:expired": [];
  /**
   * Unrecoverable auth failure — the credential provider rejected with an
   * `AuthRefreshFailedError` (refresh token expired/revoked). The connection
   * has stopped trying to reconnect; the consumer should surface a recovery
   * prompt to the operator (re-run `first-tree login <token>`) and
   * usually exit so a supervisor can back off instead of looping at 1 Hz.
   */
  "auth:fatal": [error: Error];
  "server:welcome": [welcome: ServerWelcome];
};

/**
 * Thrown (emitted on `error` and rejected from `connect()`) when the server
 * refuses a `client:register` because the local clientId is bound to a
 * different organization. Retained for wire compatibility — the read paths
 * that produced this code were retired in decouple-client-from-identity §4.1.
 */
export class ClientOrgMismatchError extends Error {
  readonly code = "CLIENT_ORG_MISMATCH";
  constructor(message = "Client belongs to a different organization") {
    super(message);
    this.name = "ClientOrgMismatchError";
  }
}

/**
 * Thrown when the server refuses `client:register` because the local
 * client.yaml is owned by a different user. The CLI detects this via
 * `instanceof` and guides the operator to run
 * `first-tree login <token> --override` to take ownership (which unpins
 * the previous owner's agents from this machine). See decouple-client-from-
 * identity §4.4.
 */
export class ClientUserMismatchError extends Error {
  readonly code = "CLIENT_USER_MISMATCH";
  constructor(message = "Client belongs to a different user") {
    super(message);
    this.name = "ClientUserMismatchError";
  }
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * Silence watchdog: if no server frame (data message OR control-frame pong)
 * arrives within this many ms, the socket is presumed dead and terminated so
 * the close handler can drive a reconnect. Sized to ~3 heartbeat ticks so a
 * single missed pong is tolerated, but a wedged socket (e.g. after the OS
 * resumes from suspend with a half-open TCP connection) is broken within one
 * minute of the next heartbeat tick.
 */
const HEARTBEAT_TIMEOUT_MS = 90_000;
/**
 * Unified-user-token C5: reconnect PROACTIVELY this many ms before the JWT's
 * `exp` claim so the client rotates to a fresh JWT without ever hitting the
 * server-side `auth:expired` push. The provider's next `getAccessToken()` call
 * is expected to return a refreshed token — the CLI stores it in
 * `credentials.json` and the web app uses its refresh-on-401 loop.
 */
const AUTH_REFRESH_LEAD_MS = 60_000;

/**
 * Sleep for `ms`, resolving early if the abort signal fires. Used by
 * {@link ClientConnection.connect} so a `disconnect()` during the initial-
 * connect backoff doesn't block for the full retry interval.
 */
function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Decode a JWT payload without verifying. Returns null if malformed. */
function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const rawPayload = parts[1];
  if (!rawPayload) return null;
  try {
    const b64 = rawPayload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, "base64").toString("utf-8");
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Bash stdout reaches handlers as `string` via Buffer.toString('utf8'), so a
 * tool whose output is binary (e.g. `gh api .../actions/runs/<id>/logs`
 * returns a ZIP archive) lands in `resultPreview` peppered with U+FFFD
 * replacements and embedded NULs. PostgreSQL JSONB rejects NUL outright, which
 * used to drop the entire session event server-side; a forest of `(replacement chars)` would
 * also be useless to the UI. Replace such previews with a placeholder so the
 * event still persists and the timeline shows the call happened.
 */
const REPLACEMENT_CHAR_BINARY_THRESHOLD = 8;

function looksBinary(s: string): boolean {
  if (s.includes("\u0000")) return true;
  return (s.match(/\uFFFD/g)?.length ?? 0) > REPLACEMENT_CHAR_BINARY_THRESHOLD;
}

export function sanitizeSessionEventForTransport(event: SessionEvent): SessionEvent {
  if (event.kind !== "tool_call") return event;
  const preview = event.payload.resultPreview;
  if (preview === undefined || !looksBinary(preview)) return event;
  return {
    ...event,
    payload: {
      ...event.payload,
      resultPreview: `[binary content, ${preview.length} chars elided]`,
    },
  };
}

/**
 * Client WS — one socket per client, many agents multiplexed.
 *
 * Handshake sequence (unified-user-token):
 *   1. TCP/WS upgrade to `/api/v1/agent/ws/client` — no Authorization header.
 *   2. Send `{type:"auth", token}` where `token` is a member access JWT.
 *      Server replies `auth:ok`; without it the socket is closed (code 4401).
 *   3. Send `client:register`; server claims/verifies `clients.user_id`.
 *   4. Per agent: `agent:bind {agentId, runtimeType, runtimeVersion}` —
 *      server runs Rule R-RUN, replies `agent:bound` or `agent:bind:rejected`.
 */
export class ClientConnection extends EventEmitter<ClientConnectionEvents> {
  readonly clientId: string;
  private readonly serverUrl: string;
  private readonly sdkVersion: string | undefined;
  private readonly userAgent: string | undefined;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly getLastUpdateAttempt: (() => UpdateAttempt | null) | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  private ws: WebSocket | null = null;
  private wsConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires ~60s before JWT exp so we reconnect with a fresh token first. */
  private authRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /**
   * Monotonic timestamp of the last frame received from the server (data
   * message OR pong control frame). Consulted by the heartbeat tick to
   * detect a half-open socket (no FIN/RST yet, readyState still OPEN) so we
   * can `terminate()` it and let the close handler reconnect. Required
   * because nothing else surfaces "socket alive but peer gone" in time —
   * Linux's default TCP keep-alive only probes after ~2h of idle.
   */
  private lastServerMessageAt = 0;
  /**
   * AbortController consumed by {@link connect}'s backoff sleep so a caller
   * that runs {@link disconnect} while the initial-connect loop is between
   * attempts isn't blocked for up to RECONNECT_MAX_MS waiting for the next
   * tick to notice `closing`.
   */
  private connectAbort: AbortController | null = null;
  /**
   * If the most recent refresh attempt was rate-limited (HTTP 429), the
   * server-suggested wait in ms — consumed by the next `scheduleReconnect`
   * to floor its delay so we don't keep retrying inside the same 60s
   * limiter window. Cleared after one use.
   */
  private nextReconnectMinDelayMs = 0;
  private closing = false;
  private registered = false;
  /** Count of `server:welcome` frames received; drives `isReconnect` flag. */
  private welcomeFramesReceived = 0;
  /**
   * Last handshake error, stashed for the `close` handler to surface a typed
   * reason (e.g. {@link ClientOrgMismatchError}) instead of a generic
   * "closed before ready" when `connect()` is pending.
   */
  private lastHandshakeError: Error | null = null;

  private readonly wsLogger: pino.Logger;
  private readonly authLogger: pino.Logger;

  private readonly boundAgents = new Map<string, BoundAgent>();

  /** Agents scheduled to rebind automatically on every reconnect. */
  private readonly desiredBindings = new Map<
    string,
    { agentId: string; runtimeType: string; runtimeVersion?: string }
  >();

  private pendingBinds = new Map<
    string,
    {
      agentId: string;
      runtimeType: string;
      runtimeVersion?: string;
      resolve: (agent: BoundAgent) => void;
      reject: (err: Error) => void;
    }
  >();

  /**
   * In-flight image writes from recent `image_payload` frames. `image_payload`
   * arrives on the WS just before `inbox:deliver` for the same message, but
   * the EventEmitter dispatch is sync — so without gating, the deliver
   * handler can fire before the image bytes hit disk. Block `inbox:deliver`
   * emission until these settle.
   */
  private readonly pendingImageWrites = new Set<Promise<void>>();

  constructor(config: ClientConnectionConfig) {
    super();
    this.clientId = config.clientId ?? process.env.FIRST_TREE_CLIENT_ID ?? `client_${randomUUID().slice(0, 8)}`;
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.sdkVersion = config.sdkVersion;
    this.userAgent = config.userAgent;
    this.getAccessToken = config.getAccessToken;
    this.getLastUpdateAttempt = config.getLastUpdateAttempt;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.wsLogger = createLogger("ws").child({ clientId: this.clientId });
    this.authLogger = createLogger("auth").child({ clientId: this.clientId });

    // Tombstone listener: Node's EventEmitter re-throws `error` events that
    // have no listener, so a stray ECONNRESET would crash the host. Consumers
    // (AgentRuntime / ClientRuntime) attach their own listeners for logging —
    // this one is the fallback for raw-SDK users who don't.
    this.on("error", () => {});
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.registered;
  }

  get agents(): ReadonlyMap<string, BoundAgent> {
    return this.boundAgents;
  }

  /**
   * Ack a delivered inbox entry over the WS data plane. Safe to call when the
   * WS is closed — the frame is dropped (logged) and the entry will time out
   * server-side and re-deliver on reconnect. The handler has by then already
   * started processing, so reaper-driven redelivery surfaces as a duplicate
   * dispatch on the next connect; SessionManager's dedupe key
   * `(chatId, messageId)` collapses it.
   */
  sendInboxAck(entryId: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Visibility for the "ack lost on closed socket → server reaper resets
      // entry to pending → duplicate dispatch on reconnect" path. Warn-level
      // so staging can correlate spikes against reconnect-storm windows.
      this.wsLogger.warn({ entryId, readyState: this.ws?.readyState }, "inbox:ack dropped — socket not OPEN");
      return;
    }
    this.ws.send(JSON.stringify({ type: "inbox:ack", entryId }));
  }

  /**
   * Bring up the socket, retrying transient handshake failures with the same
   * exponential schedule as {@link scheduleReconnect}. Resolves once the
   * server has acknowledged `client:register`; rejects only when something
   * unrecoverable has flipped `closing` (auth:fatal, register:rejected for
   * user/org mismatch). Without this loop, a temporary DNS hiccup at startup
   * propagated up to `client-runtime.start` and exited the process — which
   * leaned on systemd's restart to recover instead of the in-process backoff
   * the live reconnect path already uses.
   */
  async connect(): Promise<void> {
    this.closing = false;
    this.connectAbort = new AbortController();
    let attempt = 0;
    try {
      while (true) {
        try {
          await this.openWebSocket();
          return;
        } catch (err) {
          if (this.closing) throw err;
          attempt++;
          const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
          this.wsLogger.warn(
            { attempt, delayMs, err: err instanceof Error ? err.message : String(err) },
            "initial connect failed, will retry",
          );
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
          await waitWithAbort(delayMs, this.connectAbort.signal);
          if (this.closing) throw err;
        }
      }
    } finally {
      this.connectAbort = null;
    }
  }

  /**
   * Bind an agent to this client connection. The server decides whether the
   * agent may actually run here (Rule R-RUN); if not, a rejection arrives on
   * the `agent:bind:rejected` event and the returned promise rejects.
   */
  async bindAgent(agentId: string, runtimeType: string, runtimeVersion?: string): Promise<BoundAgent> {
    if (!this.isConnected) {
      throw new Error("Client not connected");
    }

    this.desiredBindings.set(agentId, { agentId, runtimeType, runtimeVersion });
    return this.sendBind(agentId, runtimeType, runtimeVersion);
  }

  async unbindAgent(agentId: string): Promise<void> {
    this.desiredBindings.delete(agentId);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "agent:unbind", agentId }));
    this.boundAgents.delete(agentId);
  }

  reportSessionState(agentId: string, chatId: string, state: SessionState): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "session:state", agentId, chatId, state }));
  }

  reportRuntimeState(agentId: string, runtimeState: RuntimeState): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "runtime:state", agentId, runtimeState }));
  }

  reportSessionEvent(agentId: string, chatId: string, event: SessionEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const sanitized = sanitizeSessionEventForTransport(event);
    this.ws.send(JSON.stringify({ type: "session:event", agentId, chatId, event: sanitized }));
  }

  /** Ask the server which of the supplied chatIds the client should drop. */
  sendSessionReconcile(agentId: string, chatIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "session:reconcile", agentId, chatIds }));
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.connectAbort?.abort();
    this.clearTimers();
    this.rejectAllPendingBinds("Client disconnected");
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, "Client disconnect");
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        // CONNECTING socket would otherwise sit on the kernel TCP timeout
        // (~1–2 min) before resolving. With the new connect() retry loop the
        // odds of disconnect racing an in-flight handshake go from "rare"
        // (old behaviour: connect failure threw immediately) to "every shut-
        // down during backoff is one tick away from this case", so reach for
        // terminate to abort the handshake right now.
        this.ws.terminate();
      }
      this.ws = null;
    }
    this.registered = false;
    this.boundAgents.clear();
    this.emit("disconnected");
  }

  // ---- Bind helper --------------------------------------------------------

  private sendBind(agentId: string, runtimeType: string, runtimeVersion?: string): Promise<BoundAgent> {
    return new Promise<BoundAgent>((resolve, reject) => {
      const ref = randomUUID().slice(0, 12);
      this.pendingBinds.set(ref, { agentId, runtimeType, runtimeVersion, resolve, reject });
      this.ws?.send(
        JSON.stringify({
          type: "agent:bind",
          ref,
          agentId,
          runtimeType,
          runtimeVersion,
        }),
      );
    });
  }

  // ---- WebSocket management ----------------------------------------------

  private openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.serverUrl.replace(/^http/, "ws")}/api/v1/agent/ws/client`;
      this.wsLogger.info({ url: wsUrl }, "connecting");
      // UA on the WS upgrade request closes a forensic gap: failures during
      // the upgrade (4401 close, expired token, handshake aborts) happen
      // before `client:register` lands, so without UA the trace has no install
      // identifier at all. Issue #246.
      const ws = new WebSocket(wsUrl, this.userAgent ? { headers: { "User-Agent": this.userAgent } } : undefined);
      let settled = false;

      const settle = (fn: typeof resolve | typeof reject, value?: unknown) => {
        if (settled) return;
        settled = true;
        if (this.wsConnectTimer) {
          clearTimeout(this.wsConnectTimer);
          this.wsConnectTimer = null;
        }
        if (fn === resolve) {
          (fn as typeof resolve)();
        } else {
          (fn as typeof reject)(value);
        }
      };

      this.wsConnectTimer = setTimeout(() => {
        this.wsConnectTimer = null;
        ws.terminate();
        settle(reject, new Error("WebSocket connect timeout"));
      }, WS_CONNECT_TIMEOUT_MS);

      ws.on("open", async () => {
        this.ws = ws;
        // Don't reset reconnectAttempt here — a TCP/WS handshake succeeding
        // but the auth phase failing is exactly the loop the client.log
        // captured at 19:40 (1 Hz reconnect storm with `failed to obtain
        // access token`). Resetting on `open` collapsed the exponential
        // backoff to attempt=1 forever. Reset on the application-layer
        // success signal — `client:registered` — instead.
        this.wsLogger.debug("socket opened, sending auth");

        try {
          // Ask for a token still valid past our proactive-refresh lead
          // time, otherwise the cached token returned here would already be
          // inside the lead window and the next proactive refresh would be
          // a no-op — server would push `auth:expired` instead.
          //
          // The +5_000 is just a readability slack so the boundary check
          // explicitly clears the lead window rather than comparing equal.
          // Any positive epsilon would do; 5s reads as deliberate at a
          // glance and is small enough to never matter operationally.
          const token = await this.getAccessToken({ minValidityMs: AUTH_REFRESH_LEAD_MS + 5_000 });
          ws.send(JSON.stringify({ type: "auth", token }));
          // C5: arm the proactive refresh timer as soon as we've sent the
          // auth frame — auth:ok only confirms the token was accepted, the
          // exp itself is already fixed on the token payload.
          this.scheduleProactiveAuthRefresh(token);
        } catch (err) {
          this.authLogger.error({ err }, "failed to obtain access token");
          // Refresh token expired / revoked is unrecoverable from inside the
          // process — no amount of retrying will succeed without the
          // operator running `first-tree login <new-token>`. Mark the
          // connection closed so `ws.on("close")` doesn't reschedule, and
          // surface an `auth:fatal` event so the consumer (typically the
          // CLI) can print a recovery prompt and exit, letting systemd /
          // launchd back off instead of looping at the WS reconnect base.
          //
          // `name` duck-typed instead of `instanceof` so this file doesn't
          // pull a runtime dependency on the command package (one-way:
          // command depends on client, not the other way around).
          const e = err instanceof Error ? err : new Error(String(err));
          if (e.name === "AuthRefreshFailedError") {
            this.closing = true;
            this.emit("auth:fatal", e);
          } else if (e.name === "AuthRefreshRateLimitedError") {
            // Pull the server-suggested wait off the typed error and stash it
            // for the next scheduleReconnect; falls back to 30s if absent.
            // Without this floor the WS layer's 1/2/4/8s exponential backoff
            // hammers the rate-limit window from below and stretches the
            // outage from "1 minute" to "however long until the bucket
            // empties under our own load".
            const retryAfterMs = (e as { retryAfterMs?: number }).retryAfterMs ?? 30_000;
            this.nextReconnectMinDelayMs = Math.max(this.nextReconnectMinDelayMs, retryAfterMs);
            this.authLogger.warn({ retryAfterMs }, "refresh rate-limited; deferring reconnect");
          }
          settle(reject, e);
          ws.close();
        }
      });

      ws.on("message", (data) => {
        // Any inbound frame proves the peer is alive — refresh the silence
        // watchdog before parsing so malformed frames still count.
        this.lastServerMessageAt = Date.now();
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleMessage(msg, () => settle(resolve));
        } catch {
          // ignore malformed messages
        }
      });

      // RFC 6455 pong: the ws library auto-replies to peer pings, but we also
      // send our own pings from the heartbeat tick — those round-trips are
      // what surface a wedged socket within HEARTBEAT_TIMEOUT_MS.
      ws.on("pong", () => {
        this.lastServerMessageAt = Date.now();
      });

      ws.on("close", (code) => {
        this.stopHeartbeat();
        this.clearAuthRefreshTimer();
        const wasRegistered = this.registered;
        this.registered = false;
        this.rejectAllPendingBinds("WebSocket closed");

        if (!settled) {
          this.wsLogger.warn({ code }, "closed before ready");
          const typedErr = this.lastHandshakeError;
          this.lastHandshakeError = null;
          settle(reject, typedErr ?? new Error(`WebSocket closed before ready (code ${code})`));
          return;
        }

        // Code 1000 is a clean close — the only one we issue ourselves is
        // the proactive auth refresh, which is expected and recovers
        // silently. Surface it at info so genuine drops (4401, 1006, etc.)
        // remain warn-visible.
        if (code === 1000) {
          this.wsLogger.info({ code, wasRegistered }, "disconnected");
        } else {
          this.wsLogger.warn({ code, wasRegistered }, "disconnected");
        }
        if (!this.closing) {
          this.emit("disconnected");
          if (wasRegistered) this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this.emit("error", err);
      });
    });
  }

  private handleMessage(msg: Record<string, unknown>, connectResolve?: () => void): void {
    const type = msg.type as string;

    if (type === "auth:ok") {
      this.authLogger.info("auth accepted, registering client");
      // Pull the last update attempt synchronously off disk so the
      // register frame carries up-to-date status. Throwing here would
      // kill registration, so we swallow any unexpected error (the
      // accessor reads a small JSON file — disk errors are the only
      // realistic failure mode, and the worst-case outcome is just
      // omitting the field, which the server schema already tolerates).
      let lastUpdateAttempt: UpdateAttempt | null = null;
      try {
        lastUpdateAttempt = this.getLastUpdateAttempt?.() ?? null;
      } catch (err) {
        this.authLogger.warn({ err }, "getLastUpdateAttempt threw; omitting from register frame");
      }
      this.ws?.send(
        JSON.stringify({
          type: "client:register",
          clientId: this.clientId,
          hostname: getHostname(),
          os: platform(),
          sdkVersion: this.sdkVersion,
          ...(lastUpdateAttempt ? { lastUpdateAttempt } : {}),
        }),
      );
      return;
    }

    if (type === "server:welcome") {
      const parsed = serverWelcomeFrameSchema.safeParse(msg);
      if (!parsed.success) {
        // Malformed welcome frame from a buggy server build — log and drop.
        // Old clients that never knew about this frame simply fall through,
        // so treating a parse failure the same way keeps behaviour aligned.
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed server:welcome frame",
        );
        return;
      }
      const isReconnect = this.welcomeFramesReceived > 0;
      this.welcomeFramesReceived++;
      this.emit("server:welcome", { frame: parsed.data, isReconnect });
      return;
    }

    if (type === "auth:rejected" || type === "auth:expired") {
      // The close handler reads `this.registered` to decide whether to
      // reconnect; clearing it here would make that decision see post-close
      // state and skip the reconnect after a mid-session auth:expired push.
      if (type === "auth:expired") {
        this.authLogger.info("token expired, reconnecting with fresh token");
        this.emit("auth:expired");
      } else {
        // auth:rejected means the token itself was refused — retrying with
        // the same token would just thrash. Mark closing so neither the
        // close-handler reconnect path nor the initial-connect retry loop
        // tries again, and reuse the auth:fatal channel so the consumer
        // surfaces the same recovery prompt (re-run `connect <token>`) +
        // `process.exit(75)` it already runs for AuthRefreshFailedError.
        // Without the emit, both runtime and initial-handshake paths would
        // die silently — process stays up, no recovery message, agents
        // wedged.
        this.authLogger.warn("auth rejected by server");
        this.closing = true;
        this.emit("auth:fatal", new Error("Server rejected access token (auth:rejected)"));
      }
      this.ws?.close(4401, type);
      return;
    }

    if (type === "client:register:rejected") {
      const code = typeof msg.code === "string" ? msg.code : undefined;
      const message = typeof msg.message === "string" ? msg.message : "unknown";
      // Mark closing so the WS `close` handler does not auto-reconnect — a
      // reconnect with the same clientId would just re-trigger the rejection.
      // The caller (CLI) is expected to surface the mismatch to the user,
      // abandon the local clientId, and start a fresh connection with a new
      // one. See docs/multi-tenancy-hardening-design.md (B4).
      this.closing = true;
      const err =
        code === "CLIENT_USER_MISMATCH"
          ? new ClientUserMismatchError(message)
          : code === "CLIENT_ORG_MISMATCH"
            ? new ClientOrgMismatchError(message)
            : new Error(`client:register rejected: ${message}`);
      this.lastHandshakeError = err;
      this.wsLogger.error({ code, message }, "client register rejected");
      this.emit("error", err);
      this.ws?.close(4403, "register rejected");
      return;
    }

    if (type === "client:registered") {
      const isReconnect = this.boundAgents.size > 0 || this.desiredBindings.size > 0;
      this.registered = true;
      // Application-layer success — only now is it safe to reset the backoff
      // counter. A TCP-only success (`ws.on("open")`) is not enough; an auth
      // failure between `open` and `client:registered` would otherwise
      // collapse the exponential backoff to attempt=1.
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.wsLogger.info({ isReconnect }, "registered");
      this.emit("connected");
      connectResolve?.();

      if (isReconnect) {
        this.rebindAgents();
      }
      return;
    }

    if (type === "agent:bound") {
      const agentId = msg.agentId as string;
      const ref = msg.ref as string | undefined;
      const pending = ref ? this.pendingBinds.get(ref) : undefined;
      if (ref) this.pendingBinds.delete(ref);
      if (pending) {
        const sdk = new FirstTreeHubSDK({
          serverUrl: this.serverUrl,
          getAccessToken: this.getAccessToken,
          agentId,
          userAgent: this.userAgent,
        });
        const agent: BoundAgent = {
          agentId,
          // Phase 2: server always sends a non-null displayName; fall back to
          // the agentId defensively so a schema-mismatched frame from an
          // older server doesn't crash the runtime.
          displayName: (msg.displayName as string | null) ?? agentId,
          agentType: (msg.agentType as string) ?? "personal_assistant",
          sdk,
        };
        this.boundAgents.set(agentId, agent);
        this.emit("agent:bound", agent);
        pending.resolve(agent);
      }
      return;
    }

    if (type === "agent:bind:rejected") {
      const ref = msg.ref as string | undefined;
      const reason = (msg.reason as AgentBindRejectReason) ?? "wrong_client";
      const pending = ref ? this.pendingBinds.get(ref) : undefined;
      if (ref && pending) {
        this.pendingBinds.delete(ref);
        this.emit("agent:bind:rejected", reason, pending.agentId);
        pending.reject(new Error(`agent:bind rejected (${reason})`));
      }
      return;
    }

    if (type === "agent:unbound") {
      const agentId = msg.agentId as string;
      this.boundAgents.delete(agentId);
      this.emit("agent:unbound", agentId);
      return;
    }

    if (type === "agent:pinned") {
      const parsed = agentPinnedMessageSchema.safeParse(msg);
      if (parsed.success) {
        this.emit("agent:pinned", parsed.data);
      }
      return;
    }

    if (type === "agent:force_disconnect") {
      const agentId = msg.agentId as string;
      if (agentId && this.boundAgents.has(agentId)) {
        this.boundAgents.delete(agentId);
        this.emit("agent:unbound", agentId);
      }
      return;
    }

    if (type === "session:suspend" || type === "session:terminate") {
      const agentId = msg.agentId as string;
      const chatId = msg.chatId as string;
      if (agentId && chatId) {
        this.emit("session:command", { type: type as SessionCommand["type"], agentId, chatId });
      }
      return;
    }

    if (type === "session:reconcile:result") {
      const agentId = msg.agentId as string;
      const staleChatIds = Array.isArray(msg.staleChatIds) ? (msg.staleChatIds as string[]) : null;
      if (agentId && staleChatIds) {
        this.emit("session:reconcile:result", { agentId, staleChatIds });
      }
      return;
    }

    if (type === "image_payload") {
      const parsed = imagePayloadFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn({ err: parsed.error.flatten() }, "malformed image_payload frame — dropping");
        return;
      }
      const { imageId, chatId, mimeType, base64 } = parsed.data;
      const write = writeImage({ chatId, imageId, mimeType, base64 })
        .then(() => {})
        .catch((err: unknown) => {
          this.wsLogger.warn({ err, imageId, chatId }, "image_payload write failed");
        });
      this.pendingImageWrites.add(write);
      write.finally(() => this.pendingImageWrites.delete(write));
      return;
    }

    if (type === "inbox:deliver") {
      const parsed = inboxDeliverFrameSchema.safeParse(msg);
      if (!parsed.success) {
        // Best-effort ack: without it the server's reaper rolls the entry
        // back to `pending` 300s later and re-pushes the same frame, which
        // this build is guaranteed to drop again. The retry loop runs up
        // to maxRetries before the entry is abandoned — pure spam in both
        // directions. `entryId` is a top-level field and usually survives
        // when inner `message` validation is what failed (see frameKeys).
        // Logged separately as `entryIdAcked` so operators can correlate.
        const rawEntryId = msg.entryId;
        // Match `inboxAckFrameSchema`: non-negative integer. A `typeof "number"`
        // check alone would let NaN / Infinity / floats slip through and ack
        // would silently no-op on the server side (rejected by its own schema).
        const entryIdAcked =
          typeof rawEntryId === "number" && Number.isInteger(rawEntryId) && rawEntryId >= 0 ? rawEntryId : null;
        if (entryIdAcked !== null) {
          this.sendInboxAck(entryIdAcked);
        }
        // Per-issue path/message + the receiving frame keys so we can pinpoint
        // shape drift between server build and client schema during gradual
        // rollouts. Frame body intentionally not logged in full — message
        // content can be sensitive — but the top-level keys + missing/extra
        // fields are enough to spot e.g. a renamed/dropped column.
        this.wsLogger.warn(
          {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
              message: i.message,
            })),
            frameKeys: Object.keys(msg),
            messageKeys: msg.message && typeof msg.message === "object" ? Object.keys(msg.message) : null,
            entryIdAcked,
          },
          "malformed inbox:deliver frame — dropping",
        );
        return;
      }
      // Image-write race guard: server pushes `image_payload` immediately
      // before `inbox:deliver`, so make sure disk writes flush before the
      // runtime tries to render the message.
      const emit = () => this.emit("inbox:deliver", parsed.data.inboxId, parsed.data);
      if (this.pendingImageWrites.size > 0) {
        Promise.all([...this.pendingImageWrites]).finally(emit);
      } else {
        emit();
      }
      return;
    }

    if (type === "error") {
      const errorMsg = msg.message as string;
      const ref = msg.ref as string | undefined;
      const pending = ref ? this.pendingBinds.get(ref) : undefined;
      if (pending && ref) {
        this.pendingBinds.delete(ref);
        pending.reject(new Error(errorMsg));
      } else {
        this.emit("error", new Error(errorMsg));
      }
    }
  }

  /** Re-bind all agents after reconnection. */
  private rebindAgents(): void {
    this.emit("reconnected");
    for (const desired of this.desiredBindings.values()) {
      this.sendBind(desired.agentId, desired.runtimeType, desired.runtimeVersion)
        .then((rebound) => {
          this.boundAgents.set(rebound.agentId, rebound);
        })
        .catch((err) => {
          this.boundAgents.delete(desired.agentId);
          this.emit("agent:unbound", desired.agentId);
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        });
    }
  }

  private scheduleReconnect(): void {
    // Guard against an entry from auth:fatal / disconnect() racing with the
    // close handler — `closing=true` means "no more reconnects", honoured here.
    if (this.closing) return;
    this.reconnectAttempt++;
    this.emit("reconnecting", this.reconnectAttempt);

    const exponential = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_MS);
    // Honour a 429 Retry-After from the most recent refresh attempt: take
    // whichever is larger, then consume the floor so subsequent attempts
    // (after the limiter window opens up again) revert to the normal
    // exponential schedule. Without this, the next attempt would also
    // wait ≥retryAfter, effectively halting reconnects until manual reset.
    const floor = this.nextReconnectMinDelayMs;
    this.nextReconnectMinDelayMs = 0;
    let delay = Math.max(exponential, floor);
    if (floor > 0) {
      // ±20% jitter applies only to the 429 path, where multiple clients
      // sharing an IP (NAT / CI pool) can otherwise all hit the same
      // Retry-After deadline simultaneously and reform the limiter spike.
      // Organic exponential backoff doesn't need jitter — each connection
      // entered the loop at its own arbitrary moment already.
      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      delay = Math.max(0, Math.round(delay + jitter));
    }
    this.wsLogger.debug(
      { attempt: this.reconnectAttempt, delayMs: delay, floorMs: floor || undefined },
      "scheduling reconnect",
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing) {
        this.openWebSocket().catch((err) => {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
          if (!this.closing) this.scheduleReconnect();
        });
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Seed the watchdog so the first tick doesn't immediately trip on a fresh
    // socket that has only seen the welcome frame.
    this.lastServerMessageAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Silence watchdog: if neither a data frame nor a pong has come back
      // within HEARTBEAT_TIMEOUT_MS, the TCP half is presumably dead (this
      // is exactly the OS-suspend / NAT-rebind / silent-router-drop shape
      // where readyState stays OPEN but bytes never arrive). Force a close
      // so the existing handler reschedules a reconnect — sending another
      // heartbeat on a wedged socket would just queue bytes nobody reads.
      const silenceMs = Date.now() - this.lastServerMessageAt;
      if (silenceMs > this.heartbeatTimeoutMs) {
        this.wsLogger.warn(
          { silenceMs, timeoutMs: this.heartbeatTimeoutMs },
          "no server activity within heartbeat timeout — terminating socket to force reconnect",
        );
        ws.terminate();
        return;
      }

      // Application-level heartbeat keeps server-side presence /
      // last-seen counters fresh (clientService.heartbeatClient,
      // presenceService.touchAgent). RFC 6455 ping is what the watchdog
      // actually relies on — the ws library on the server side
      // auto-replies with a pong, giving us a transport-level liveness
      // check independent of any application handler. Both are wrapped:
      // a send() race against readyState (e.g. the socket transitioned to
      // CLOSING between the guard and the call) would otherwise propagate
      // out of the interval callback as an unhandled exception. The
      // silence watchdog above is the source of truth — losing a single
      // send is fine.
      try {
        ws.send(JSON.stringify({ type: "heartbeat" }));
        ws.ping();
      } catch {
        // ignore — the silence watchdog above is the source of truth
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private rejectAllPendingBinds(reason: string): void {
    for (const [, pending] of this.pendingBinds) {
      pending.reject(new Error(reason));
    }
    this.pendingBinds.clear();
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.wsConnectTimer) {
      clearTimeout(this.wsConnectTimer);
      this.wsConnectTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearAuthRefreshTimer();
  }

  private clearAuthRefreshTimer(): void {
    if (this.authRefreshTimer) {
      clearTimeout(this.authRefreshTimer);
      this.authRefreshTimer = null;
    }
  }

  /**
   * Proactive JWT refresh (C5). Schedule a silent reconnect ~60s before the
   * access token expires so `getAccessToken()` is asked for a fresh JWT
   * before the server's scheduleAuthExpiry timer fires. Short-lived tokens
   * (exp <= lead window) skip the proactive reconnect entirely — we let the
   * server push `auth:expired` and handle that path.
   *
   * Order is "refresh-then-close", not "close-then-let-reconnect-refresh".
   * The earlier shape relied on the new connection's open handler to do the
   * `/auth/refresh` HTTP, which forced ≥1s of WS downtime per cycle even on
   * the happy path (one base reconnect delay + the refresh round-trip) and
   * compounded badly under 429: every retry attempt also closed/reopened the
   * WS, holding the agent offline for 15-20s while the limiter cooled down.
   * Refreshing first lets us swap the new token onto a still-open WS with no
   * observable disconnect when the refresh succeeds; the original close-and-
   * reconnect flow only runs on failure as a last-ditch fallback (it'll hit
   * the same 429 on its next retry, but at least the Retry-After floor is
   * now wired up so we don't pile attempts inside the same window).
   */
  private scheduleProactiveAuthRefresh(token: string): void {
    this.clearAuthRefreshTimer();
    const exp = decodeJwtExp(token);
    if (!exp) return;
    const delay = exp * 1000 - Date.now() - AUTH_REFRESH_LEAD_MS;
    if (delay <= 0) return;
    this.authLogger.debug({ delayMs: delay }, "scheduled proactive auth refresh");
    this.authRefreshTimer = setTimeout(() => {
      void this.runProactiveAuthRefresh();
    }, delay);
  }

  private async runProactiveAuthRefresh(): Promise<void> {
    this.authRefreshTimer = null;
    if (this.closing) return;
    this.authLogger.info("triggering proactive auth refresh");
    try {
      // Force a fetch — the cached token is by definition still inside the
      // 60s lead window here, so we ask for >lead validity to make
      // ensureFreshAccessToken treat it as stale and call /auth/refresh.
      // The returned token is also written to credentials.json by the
      // bootstrap layer, so the reconnect that follows can pick it up
      // without a second HTTP round-trip.
      await this.getAccessToken({ minValidityMs: AUTH_REFRESH_LEAD_MS + 5_000 });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.name === "AuthRefreshRateLimitedError") {
        // Stash Retry-After for the close-handler-driven scheduleReconnect
        // that fires below — without this it would reuse the 1s base delay
        // and hammer the limiter inside the same 60s window.
        const retryAfterMs = (e as { retryAfterMs?: number }).retryAfterMs ?? 30_000;
        this.nextReconnectMinDelayMs = Math.max(this.nextReconnectMinDelayMs, retryAfterMs);
        this.authLogger.warn({ retryAfterMs }, "proactive refresh rate-limited; deferring reconnect");
      } else if (e.name === "AuthRefreshFailedError") {
        // Refresh token revoked/expired — surface fatal so the consumer
        // (CLI) can prompt for `connect` instead of looping. Skip the
        // close-and-reconnect dance since reconnecting would just throw
        // the same error from the open handler.
        this.closing = true;
        this.emit("auth:fatal", e);
        return;
      } else {
        this.authLogger.warn({ err: e }, "proactive refresh failed; falling back to reconnect path");
      }
      // Fall through to close — the legacy reconnect-driven retry path
      // takes over from here.
    }

    // Close gracefully whether refresh succeeded or not. On success the
    // close handler triggers a reconnect whose open handler reads the
    // freshly-cached token (no second /auth/refresh), collapsing the
    // disconnect window to a single TCP/WS handshake (~1 RTT). On failure
    // it falls back to the original close-then-retry flow with the
    // 429-aware backoff floor in place.
    this.ws?.close(1000, "proactive auth refresh");
  }
}
