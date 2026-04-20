import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname as getHostname, platform } from "node:os";
import type {
  AgentBindRejectReason,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@agent-team-foundation/first-tree-hub-shared";
import WebSocket from "ws";
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
};

export type BoundAgent = {
  agentId: string;
  displayName: string | null;
  agentType: string;
  sdk: FirstTreeHubSDK;
};

export type SessionCommand = {
  type: "session:suspend" | "session:resume" | "session:terminate";
  agentId: string;
  chatId: string;
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
  "agent:bind:rejected": [reason: AgentBindRejectReason, agentId: string];
  "session:command": [command: SessionCommand];
  "auth:expired": [];
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
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
  private readonly getAccessToken: AccessTokenProvider;

  private ws: WebSocket | null = null;
  private wsConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires ~60s before JWT exp so we reconnect with a fresh token first. */
  private authRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closing = false;
  private registered = false;

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

  constructor(config: ClientConnectionConfig) {
    super();
    this.clientId = config.clientId ?? process.env.FIRST_TREE_HUB_CLIENT_ID ?? `client_${randomUUID().slice(0, 8)}`;
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.sdkVersion = config.sdkVersion;
    this.getAccessToken = config.getAccessToken;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.registered;
  }

  get agents(): ReadonlyMap<string, BoundAgent> {
    return this.boundAgents;
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

  reportSessionEvent(agentId: string, chatId: string, event: SessionEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "session:event", agentId, chatId, event }));
  }

  reportSessionCompletion(agentId: string, chatId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "session:completion", agentId, chatId }));
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

  // ---- WebSocket management ----------------------------------------------

  private openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.serverUrl.replace(/^http/, "ws")}/api/v1/agent/ws/client`;
      const ws = new WebSocket(wsUrl);
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
        this.reconnectAttempt = 0;

        try {
          const token = await this.getAccessToken();
          ws.send(JSON.stringify({ type: "auth", token }));
          // C5: arm the proactive refresh timer as soon as we've sent the
          // auth frame — auth:ok only confirms the token was accepted, the
          // exp itself is already fixed on the token payload.
          this.scheduleProactiveAuthRefresh(token);
        } catch (err) {
          settle(reject, err instanceof Error ? err : new Error(String(err)));
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
        this.rejectAllPendingBinds("WebSocket closed");

        if (!settled) {
          settle(reject, new Error(`WebSocket closed before ready (code ${code})`));
          return;
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
      this.ws?.send(
        JSON.stringify({
          type: "client:register",
          clientId: this.clientId,
          hostname: getHostname(),
          os: platform(),
          sdkVersion: this.sdkVersion,
        }),
      );
      return;
    }

    if (type === "auth:rejected" || type === "auth:expired") {
      this.registered = false;
      if (type === "auth:expired") this.emit("auth:expired");
      this.ws?.close(4401, type);
      return;
    }

    if (type === "client:register:rejected") {
      const err = new Error(`client:register rejected: ${msg.message ?? "unknown"}`);
      this.emit("error", err);
      this.ws?.close(4403, "register rejected");
      return;
    }

    if (type === "client:registered") {
      const isReconnect = this.boundAgents.size > 0 || this.desiredBindings.size > 0;
      this.registered = true;
      this.startHeartbeat();
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
        });
        const agent: BoundAgent = {
          agentId,
          displayName: (msg.displayName as string) ?? null,
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

    if (type === "agent:force_disconnect") {
      const agentId = msg.agentId as string;
      if (agentId && this.boundAgents.has(agentId)) {
        this.boundAgents.delete(agentId);
        this.emit("agent:unbound", agentId);
      }
      return;
    }

    if (type === "session:suspend" || type === "session:resume" || type === "session:terminate") {
      const agentId = msg.agentId as string;
      const chatId = msg.chatId as string;
      if (agentId && chatId) {
        this.emit("session:command", { type: type as SessionCommand["type"], agentId, chatId });
      }
      return;
    }

    if (type === "new_message") {
      const inboxId = msg.inboxId as string | undefined;
      if (inboxId) {
        this.emit("agent:message", inboxId, msg);
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
    this.reconnectAttempt++;
    this.emit("reconnecting", this.reconnectAttempt);

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_MS);
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
   */
  private scheduleProactiveAuthRefresh(token: string): void {
    this.clearAuthRefreshTimer();
    const exp = decodeJwtExp(token);
    if (!exp) return;
    const delay = exp * 1000 - Date.now() - AUTH_REFRESH_LEAD_MS;
    if (delay <= 0) return;
    this.authRefreshTimer = setTimeout(() => {
      this.authRefreshTimer = null;
      if (this.closing) return;
      // Silent reconnect: close gracefully, the close handler reconnects and
      // the new connection asks getAccessToken() for a fresh JWT.
      this.ws?.close(1000, "proactive auth refresh");
    }, delay);
  }
}
