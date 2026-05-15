import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname as getHostname, platform } from "node:os";
import {
  type AgentBindRejectReason,
  type AgentPinnedMessage,
  agentPinnedMessageSchema,
  type ContextTreeBindingMessage,
  type InboxDeliverFrame,
  imagePayloadFrameSchema,
  inboxDeliverFrameSchema,
  type RuntimeState,
  type ServerWelcomeFrame,
  type SessionEvent,
  type SessionState,
  serverWelcomeFrameSchema,
  type TreeWriteTaskHeartbeat,
  type TreeWriteTaskResult,
  type TreeWriteTaskStart,
  treeWriteTaskAckSchema,
  treeWriteTaskStartSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
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
  "agent:message": [agentId: string, data: unknown];
  /**
   * Server pushed a fully-assembled inbox entry over the WS data plane.
   * Listeners must call `connection.sendInboxAck(frame.entryId)` once the
   * entry has been durably handed to the session manager. Replaces the
   * legacy `agent:message` → HTTP-poll round-trip when the server
   * advertises `wsInboxDeliver`. Falls back silently on legacy paths.
   */
  "inbox:deliver": [agentId: string, frame: InboxDeliverFrame];
  "task:tree_write:start": [agentId: string, task: TreeWriteTaskStart];
  "agent:bind:rejected": [reason: AgentBindRejectReason, agentId: string];
  /**
   * Server announced that an agent has been pinned to this client (either
   * created with `clientId` or bound via PATCH NULL → ID). Consumers can use
   * this to auto-register the agent locally without a manual
   * `first-tree-hub agent add`.
   */
  "agent:pinned": [message: AgentPinnedMessage];
  "session:command": [command: SessionCommand];
  "session:reconcile:result": [result: SessionReconcileResult];
  "auth:expired": [];
  /**
   * Unrecoverable auth failure — the credential provider rejected with an
   * `AuthRefreshFailedError` (refresh token expired/revoked). The connection
   * has stopped trying to reconnect; the consumer should surface a recovery
   * prompt to the operator (re-run `first-tree-hub connect <token>`) and
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
 * `first-tree-hub client claim --confirm` to take ownership (which unpins
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
 * Client-side opt-in for the WS inbox data plane. Gates BOTH the
 * `wireCapabilities.wsInboxDeliver` flag we declare on `client:register`
 * AND how we interpret the server's welcome capability — without this AND,
 * a future client kill-switch could land in a half-state where we tell the
 * server "no thanks" but still treat welcome's `wsInboxDeliver:true` as
 * authoritative and stop the 5s HTTP poll, leaving messages stuck if a
 * NOTIFY ever drops. Hard-coded `true` for now; flip to a config knob if
 * you need a runtime kill-switch.
 */
const WS_INBOX_DELIVER_OPT_IN = true;
/**
 * Unified-user-token C5: reconnect PROACTIVELY this many ms before the JWT's
 * `exp` claim so the client rotates to a fresh JWT without ever hitting the
 * server-side `auth:expired` push. The provider's next `getAccessToken()` call
 * is expected to return a refreshed token — the CLI stores it in
 * `credentials.json` and the web app uses its refresh-on-401 loop.
 */
const AUTH_REFRESH_LEAD_MS = 60_000;

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

  private ws: WebSocket | null = null;
  private wsConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires ~60s before JWT exp so we reconnect with a fresh token first. */
  private authRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
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
   * Whether the most recent `server:welcome` frame advertised
   * `capabilities.wsInboxDeliver`. The runtime (AgentSlot) reads this
   * (via {@link supportsWsInboxDeliver}) to decide whether to keep the
   * legacy 5s HTTP poll or rely entirely on `inbox:deliver` push frames.
   * Re-evaluated on every reconnect — the welcome frame is the source of
   * truth, never assumed sticky across connections.
   */
  private wsInboxDeliverActive = false;
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
   * In-flight image writes from recent `image_payload` frames. The server
   * pushes `image_payload` immediately before firing the `new_message`
   * notification, but WS message handlers run through EventEmitter (sync
   * dispatch, no await), so the disk write can still race the HTTP poll
   * that follows. Defer `new_message` emission until these settle.
   */
  private readonly pendingImageWrites = new Set<Promise<void>>();
  private readonly pendingTreeWriteResults = new Map<string, { agentId: string; result: TreeWriteTaskResult }>();
  private readonly pendingTreeWriteHeartbeats = new Map<
    string,
    { agentId: string; heartbeat: TreeWriteTaskHeartbeat }
  >();

  constructor(config: ClientConnectionConfig) {
    super();
    this.clientId = config.clientId ?? process.env.FIRST_TREE_HUB_CLIENT_ID ?? `client_${randomUUID().slice(0, 8)}`;
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.sdkVersion = config.sdkVersion;
    this.userAgent = config.userAgent;
    this.getAccessToken = config.getAccessToken;
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
   * True when the current connection's `server:welcome` advertised
   * `capabilities.wsInboxDeliver` — meaning the server will push
   * `inbox:deliver` frames and accept `inbox:ack` frames over this WS.
   * Resets to false on every reconnect until the new welcome arrives.
   */
  get supportsWsInboxDeliver(): boolean {
    return this.wsInboxDeliverActive;
  }

  /**
   * Ack a delivered inbox entry over the WS data plane. Replaces the legacy
   * `sdk.ack()` HTTP call when the connection has negotiated
   * `wsInboxDeliver`. Safe to call when the WS is closed — the frame is
   * dropped silently and the entry will time out and re-deliver on
   * reconnect, mirroring how the legacy timeout reaper handles HTTP
   * ack-loss.
   */
  sendInboxAck(entryId: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "inbox:ack", entryId }));
  }

  async connect(): Promise<void> {
    this.closing = false;
    await this.openWebSocket();
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

  reportContextTreeBinding(agentId: string, binding: ContextTreeBindingMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "context_tree:binding", agentId, ...binding }));
  }

  reportTreeWriteTaskResult(agentId: string, result: TreeWriteTaskResult): void {
    this.pendingTreeWriteHeartbeats.delete(result.taskId);
    this.pendingTreeWriteResults.set(result.taskId, { agentId, result });
    this.flushPendingTreeWriteFrames(agentId);
  }

  reportTreeWriteTaskHeartbeat(agentId: string, taskId: string, attemptCount: number): void {
    this.pendingTreeWriteHeartbeats.set(taskId, {
      agentId,
      heartbeat: { type: "task:tree_write:heartbeat", taskId, attemptCount },
    });
    this.flushPendingTreeWriteFrames(agentId);
  }

  reportSessionEvent(agentId: string, chatId: string, event: SessionEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "session:event", agentId, chatId, event }));
  }

  /** Ask the server which of the supplied chatIds the client should drop. */
  sendSessionReconcile(agentId: string, chatIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "session:reconcile", agentId, chatIds }));
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.clearTimers();
    this.rejectAllPendingBinds("Client disconnected");
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, "Client disconnect");
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

  private flushPendingTreeWriteFrames(agentId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.boundAgents.has(agentId)) return;

    for (const [taskId, entry] of this.pendingTreeWriteHeartbeats) {
      if (entry.agentId !== agentId) continue;
      this.ws.send(JSON.stringify({ ...entry.heartbeat, agentId }));
      this.pendingTreeWriteHeartbeats.delete(taskId);
    }

    for (const entry of this.pendingTreeWriteResults.values()) {
      if (entry.agentId !== agentId) continue;
      this.ws.send(JSON.stringify({ ...entry.result, agentId }));
    }
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
          // operator running `first-tree-hub connect <new-token>`. Mark the
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
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleMessage(msg, () => settle(resolve));
        } catch {
          // ignore malformed messages
        }
      });

      ws.on("close", (code) => {
        this.stopHeartbeat();
        this.clearAuthRefreshTimer();
        const wasRegistered = this.registered;
        this.registered = false;
        // Capability is per-connection — never assume it survives a reconnect.
        // The next `server:welcome` will re-derive it from the server's flag.
        this.wsInboxDeliverActive = false;
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
      // Advertise wire-capability opt-in so a `wsDataPlane`-enabled server
      // routes NOTIFY traffic through `inbox:deliver` frames instead of
      // legacy `new_message` doorbells. Gated by WS_INBOX_DELIVER_OPT_IN —
      // see its definition for why both the wire flag and the welcome-cap
      // gate below need to share a single source of truth.
      this.ws?.send(
        JSON.stringify({
          type: "client:register",
          clientId: this.clientId,
          hostname: getHostname(),
          os: platform(),
          sdkVersion: this.sdkVersion,
          wireCapabilities: { wsInboxDeliver: WS_INBOX_DELIVER_OPT_IN },
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
      // Cache the negotiated push capability for this connection. Reset on
      // every welcome — if a reconnect lands on an older server with the
      // flag off, we transparently fall back to the HTTP poll path.
      // ANDed with WS_INBOX_DELIVER_OPT_IN so a future client kill-switch
      // (flip the const to false) takes effect symmetrically: we tell the
      // server "no thanks" via wireCapabilities AND keep the 5s HTTP poll
      // running. Without the AND, an opt-out client would see welcome's
      // `wsInboxDeliver:true` and stop polling, but the server — having
      // received `wireCapabilities.wsInboxDeliver:false` — would keep
      // sending doorbells and never push deliver frames, leaving messages
      // stuck if any NOTIFY were ever lost.
      this.wsInboxDeliverActive = parsed.data.capabilities?.wsInboxDeliver === true && WS_INBOX_DELIVER_OPT_IN;
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
        this.authLogger.warn("auth rejected by server");
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
        this.flushPendingTreeWriteFrames(agentId);
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

    if (type === "new_message") {
      const inboxId = msg.inboxId as string | undefined;
      if (!inboxId) return;
      if (this.pendingImageWrites.size > 0) {
        // Defer until recent image writes flush — the HTTP poll for this
        // message would otherwise race the disk write and surface the
        // "not available on this device" placeholder.
        Promise.all([...this.pendingImageWrites]).finally(() => {
          this.emit("agent:message", inboxId, msg);
        });
      } else {
        this.emit("agent:message", inboxId, msg);
      }
      return;
    }

    if (type === "inbox:deliver") {
      const parsed = inboxDeliverFrameSchema.safeParse(msg);
      if (!parsed.success) {
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
          },
          "malformed inbox:deliver frame — dropping",
        );
        return;
      }
      // Same image-write race guard as `new_message`: server pushes
      // `image_payload` immediately before `inbox:deliver`, so make sure
      // disk writes flush before the runtime tries to render the message.
      const emit = () => this.emit("inbox:deliver", parsed.data.inboxId, parsed.data);
      if (this.pendingImageWrites.size > 0) {
        Promise.all([...this.pendingImageWrites]).finally(emit);
      } else {
        emit();
      }
      return;
    }

    if (type === "task:tree_write:start") {
      const parsed = treeWriteTaskStartSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn({ err: parsed.error.flatten() }, "malformed task:tree_write:start frame — dropping");
        return;
      }
      const agentId = typeof msg.agentId === "string" ? msg.agentId : null;
      if (!agentId) return;
      this.emit("task:tree_write:start", agentId, parsed.data);
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
      return;
    }

    if (type === "task:tree_write:ack") {
      const parsed = treeWriteTaskAckSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn({ err: parsed.error.flatten() }, "malformed task:tree_write:ack frame — dropping");
        return;
      }
      this.pendingTreeWriteResults.delete(parsed.data.taskId);
      this.pendingTreeWriteHeartbeats.delete(parsed.data.taskId);
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
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, HEARTBEAT_INTERVAL_MS);
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
