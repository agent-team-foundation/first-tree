import { EventEmitter } from "node:events";
import type { InboxEntryWithMessage } from "@agent-hub/shared";
import WebSocket from "ws";
import { AgentHubSDK, type RegisterResult } from "./sdk.js";

export type AgentConnectionConfig = {
  serverUrl: string;
  token: string;
  /** Polling interval in ms when WebSocket is unavailable. Default: 5000 */
  pollingInterval?: number;
  /** Number of entries to pull per request. Default: 10 */
  pullLimit?: number;
};

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export type MessageHandler = (entry: InboxEntryWithMessage) => Promise<void>;

type ConnectionEvents = {
  connected: [];
  disconnected: [];
  reconnecting: [attempt: number];
  error: [error: Error];
};

const DEFAULT_POLLING_INTERVAL = 5000;
const DEFAULT_PULL_LIMIT = 10;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class AgentConnection extends EventEmitter<ConnectionEvents> {
  readonly sdk: AgentHubSDK;
  private _state: ConnectionState = "disconnected";
  private _agent: RegisterResult | null = null;
  private handler: MessageHandler | null = null;

  private ws: WebSocket | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private isPulling = false;
  private pullAgain = false;
  private closing = false;

  private readonly token: string;
  private readonly pollingInterval: number;
  private readonly pullLimit: number;
  private readonly serverUrl: string;

  constructor(config: AgentConnectionConfig) {
    super();
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.sdk = new AgentHubSDK({ serverUrl: config.serverUrl, token: config.token });
    this.pollingInterval = config.pollingInterval ?? DEFAULT_POLLING_INTERVAL;
    this.pullLimit = config.pullLimit ?? DEFAULT_PULL_LIMIT;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get agent(): RegisterResult | null {
    return this._agent;
  }

  /** Register a handler for incoming messages. */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Connect: validate token, open WebSocket, start inbox loop. */
  async connect(): Promise<RegisterResult> {
    this._state = "connecting";
    this._agent = await this.sdk.register();
    this.openWebSocket();
    return this._agent;
  }

  /** Gracefully disconnect. */
  async disconnect(): Promise<void> {
    this.closing = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, "Client disconnect");
      }
      this.ws = null;
    }
    this._state = "disconnected";
    this.emit("disconnected");
  }

  // ---- WebSocket management ------------------------------------------------

  private openWebSocket(): void {
    const wsUrl = `${this.serverUrl.replace(/^http/, "ws")}/api/v1/agent/ws/inbox`;
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this._state = "connected";
      this.emit("connected");
      // Always poll — Server does not yet push inbox notifications via WS.
      // WebSocket currently only handles presence; polling is the primary
      // message delivery mechanism until Server adds pg_notify on send.
      this.startPolling();
      // Immediate catch-up pull
      this.pullAndDispatch();
    });

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as { type?: string };
        if (parsed.type === "new_message") {
          this.pullAndDispatch();
        }
      } catch {
        // ignore unparseable frames
      }
    });

    ws.on("close", () => {
      if (!this.closing) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      this.emit("error", err);
      // close event will follow and trigger reconnect
    });

    this.ws = ws;
  }

  private scheduleReconnect(): void {
    this._state = "reconnecting";
    this.reconnectAttempt++;
    this.emit("reconnecting", this.reconnectAttempt);
    this.startPolling();

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing) {
        this.openWebSocket();
      }
    }, delay);
  }

  // ---- Polling fallback ----------------------------------------------------

  private startPolling(): void {
    if (this.pollingTimer) return;
    this.pollingTimer = setInterval(() => {
      this.pullAndDispatch();
    }, this.pollingInterval);
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  // ---- Pull & dispatch -----------------------------------------------------

  private async pullAndDispatch(): Promise<void> {
    if (this.closing || !this.handler) return;
    if (this.isPulling) {
      // A pull is in flight — mark dirty so it re-pulls when done
      this.pullAgain = true;
      return;
    }
    this.isPulling = true;
    try {
      do {
        this.pullAgain = false;
        const { entries } = await this.sdk.pull(this.pullLimit);
        for (const entry of entries) {
          if (this.closing) break;
          try {
            await this.handler(entry);
          } catch (err) {
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
          }
        }
      } while (this.pullAgain && !this.closing);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isPulling = false;
    }
  }

  // ---- Cleanup -------------------------------------------------------------

  private clearTimers(): void {
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
