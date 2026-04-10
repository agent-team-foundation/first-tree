import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname as getHostname, platform } from "node:os";
import type { SessionState } from "@agent-team-foundation/first-tree-hub-shared";
import WebSocket from "ws";
import { FirstTreeHubSDK } from "./sdk.js";

export type ClientConnectionConfig = {
  serverUrl: string;
  clientId?: string;
  sdkVersion?: string;
};

export type BoundAgent = {
  agentId: string;
  displayName: string | null;
  agentType: string;
  token: string;
  sdk: FirstTreeHubSDK;
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
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * M1 Client Connection: one WebSocket per client process, multiple agents multiplexed.
 *
 * Protocol:
 *   1. connect() → WS to /api/v1/agent/ws/client
 *   2. client:register → register with env info
 *   3. bindAgent(token, runtimeType) → agent:bind per agent (with ref for correlation)
 *   4. reportSessionState(agentId, chatId, state) → session:state
 *   5. heartbeat → client-level keepalive
 */
export class ClientConnection extends EventEmitter<ClientConnectionEvents> {
  readonly clientId: string;
  private readonly serverUrl: string;
  private readonly sdkVersion: string | undefined;

  private ws: WebSocket | null = null;
  private wsConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closing = false;
  private registered = false;

  private readonly boundAgents = new Map<string, BoundAgent>();

  /** Pending bind requests keyed by correlation ref. */
  private pendingBinds = new Map<
    string,
    {
      token: string;
      runtimeType: string;
      runtimeVersion?: string;
      resolve: (agent: BoundAgent) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(config: ClientConnectionConfig) {
    super();
    this.clientId = config.clientId ?? `client_${randomUUID().slice(0, 8)}`;
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.sdkVersion = config.sdkVersion;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.registered;
  }

  get agents(): ReadonlyMap<string, BoundAgent> {
    return this.boundAgents;
  }

  /** Connect the client WS and register. */
  async connect(): Promise<void> {
    this.closing = false;
    await this.openWebSocket();
  }

  /** Bind an agent to this client connection. */
  async bindAgent(token: string, runtimeType: string, runtimeVersion?: string): Promise<BoundAgent> {
    if (!this.isConnected) {
      throw new Error("Client not connected");
    }

    return new Promise<BoundAgent>((resolve, reject) => {
      const ref = randomUUID().slice(0, 12);
      this.pendingBinds.set(ref, { token, runtimeType, runtimeVersion, resolve, reject });
      this.ws?.send(
        JSON.stringify({
          type: "agent:bind",
          ref,
          token,
          runtimeType,
          runtimeVersion,
        }),
      );
    });
  }

  /** Unbind an agent. */
  async unbindAgent(agentId: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "agent:unbind", agentId }));
    this.boundAgents.delete(agentId);
  }

  /** Report a per-session state change for a bound agent. */
  reportSessionState(agentId: string, chatId: string, state: SessionState): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "session:state",
        agentId,
        chatId,
        state,
      }),
    );
  }

  /** Gracefully disconnect. */
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

  // ---- WebSocket management --

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

      ws.on("open", () => {
        this.reconnectAttempt = 0;
        this.ws = ws;

        // Send client:register
        ws.send(
          JSON.stringify({
            type: "client:register",
            clientId: this.clientId,
            hostname: getHostname(),
            os: platform(),
            sdkVersion: this.sdkVersion,
          }),
        );
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleMessage(msg, () => settle(resolve));
        } catch {
          // ignore malformed messages
        }
      });

      ws.on("close", () => {
        this.stopHeartbeat();
        this.registered = false;
        this.rejectAllPendingBinds("WebSocket closed");

        if (!settled) {
          // Initial connect failed before registration — reject immediately
          settle(reject, new Error("WebSocket closed before registration"));
          return;
        }

        // Already connected before — this is a drop, schedule reconnect
        if (!this.closing) {
          this.emit("disconnected");
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this.emit("error", err);
        // Don't settle here — let close handler do it (error always fires before close)
      });
    });
  }

  private handleMessage(msg: Record<string, unknown>, connectResolve?: () => void): void {
    const type = msg.type as string;

    if (type === "client:registered") {
      const isReconnect = this.boundAgents.size > 0;
      this.registered = true;
      this.startHeartbeat();
      this.emit("connected");
      connectResolve?.();

      // After reconnection, re-bind all previously bound agents
      if (isReconnect) {
        this.rebindAgents();
      }
    } else if (type === "agent:bound") {
      const agentId = msg.agentId as string;
      const ref = msg.ref as string | undefined;
      const pending = ref ? this.pendingBinds.get(ref) : undefined;
      if (ref) this.pendingBinds.delete(ref);
      if (pending) {
        const sdk = new FirstTreeHubSDK({ serverUrl: this.serverUrl, token: pending.token });
        const agent: BoundAgent = {
          agentId,
          displayName: (msg.displayName as string) ?? null,
          agentType: (msg.agentType as string) ?? "personal_assistant",
          token: pending.token,
          sdk,
        };
        this.boundAgents.set(agentId, agent);
        this.emit("agent:bound", agent);
        pending.resolve(agent);
      }
    } else if (type === "agent:unbound") {
      const agentId = msg.agentId as string;
      this.boundAgents.delete(agentId);
      this.emit("agent:unbound", agentId);
    } else if (type === "agent:force_disconnect") {
      const agentId = msg.agentId as string;
      if (agentId && this.boundAgents.has(agentId)) {
        this.boundAgents.delete(agentId);
        this.emit("agent:unbound", agentId);
      }
    } else if (type === "new_message") {
      // Route to the correct agent
      const inboxId = msg.inboxId as string | undefined;
      if (inboxId) {
        this.emit("agent:message", inboxId, msg);
      }
    } else if (type === "error") {
      const errorMsg = msg.message as string;
      const ref = msg.ref as string | undefined;
      // Match error to pending bind via ref
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
    for (const [, agent] of this.boundAgents) {
      const ref = randomUUID().slice(0, 12);
      // Re-bind with a new pending entry; on failure, remove from boundAgents
      this.pendingBinds.set(ref, {
        token: agent.token,
        runtimeType: agent.agentType,
        resolve: (rebound) => {
          // Update the entry in case agentId or displayName changed
          this.boundAgents.set(rebound.agentId, rebound);
        },
        reject: (err) => {
          // Agent couldn't be re-bound (e.g., token revoked during disconnect)
          this.boundAgents.delete(agent.agentId);
          this.emit("agent:unbound", agent.agentId);
          this.emit("error", err);
        },
      });
      this.ws?.send(
        JSON.stringify({
          type: "agent:bind",
          ref,
          token: agent.token,
          runtimeType: agent.agentType,
        }),
      );
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
        });
      }
    }, delay);
  }

  // ---- Heartbeat --

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

  // ---- Cleanup --

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
  }
}
