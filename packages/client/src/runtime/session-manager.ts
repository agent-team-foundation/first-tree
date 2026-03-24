import type { InboxEntryWithMessage } from "@agent-hub/shared";
import type { AgentHubSDK } from "../sdk.js";
import type { SessionConfig } from "./config.js";
import { toInboundMessage, toMessageFormat } from "./convert.js";
import { ProcessHandle } from "./process-handle.js";
import type { AgentOutput } from "./protocol.js";

type SessionEntry = {
  chatId: string;
  process: ProcessHandle;
  lastActivity: number;
  /** Queued messages waiting for the current one to finish. */
  messageQueue: InboxEntryWithMessage[];
  /** Whether a message is currently being processed. */
  processing: boolean;
};

type SessionManagerConfig = {
  session: SessionConfig;
  command: string;
  env?: Record<string, string>;
  agentIdentity: { agentId: string; displayName: string | null };
  sdk: AgentHubSDK;
  log: (msg: string) => void;
};

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly config: SessionManagerConfig;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    // Start idle check timer
    if (config.session.mode === "per_chat" || config.session.mode === "singleton") {
      this.idleTimer = setInterval(() => this.evictIdle(), 10_000);
    }
  }

  /** Dispatch an inbox entry to the appropriate session. */
  async dispatch(entry: InboxEntryWithMessage): Promise<void> {
    const { mode } = this.config.session;

    if (mode === "per_message") {
      await this.handlePerMessage(entry);
      return;
    }

    const sessionKey = mode === "singleton" ? "__singleton__" : (entry.chatId ?? entry.message.chatId);
    const session = this.sessions.get(sessionKey);

    if (session?.process.isAlive()) {
      session.lastActivity = Date.now();
      if (session.processing) {
        // Queue for serial delivery within the same session
        session.messageQueue.push(entry);
      } else {
        await this.processEntry(session, entry);
      }
    } else {
      // Clean up dead session if any
      if (session) {
        this.sessions.delete(sessionKey);
      }
      // Evict LRU if at capacity
      this.evictIfNeeded();
      // Spawn new session
      const newSession = this.createSession(sessionKey);
      await this.processEntry(newSession, entry);
    }
  }

  /** Shut down all sessions gracefully. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const shutdowns = [...this.sessions.values()].map((s) => s.process.gracefulShutdown());
    await Promise.allSettled(shutdowns);
    this.sessions.clear();
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  // ---- Internal -----------------------------------------------------------

  private createSession(key: string): SessionEntry {
    const chatId = key === "__singleton__" ? "" : key;

    const process = new ProcessHandle({
      command: this.config.command,
      env: this.config.env,
      onOutput: (msg) => this.handleOutput(key, msg),
      onExit: (code) => {
        this.config.log(`Session ${key}: process exited (code ${code})`);
        this.sessions.delete(key);
      },
      onError: (err) => {
        this.config.log(`Session ${key}: process error: ${err.message}`);
      },
    });

    process.start();

    const entry: SessionEntry = {
      chatId,
      process,
      lastActivity: Date.now(),
      messageQueue: [],
      processing: false,
    };

    this.sessions.set(key, entry);
    this.config.log(`Session ${key}: process started`);

    // Send session_init
    try {
      process.send({
        type: "session_init",
        agent: this.config.agentIdentity,
        chatId,
        chatType: "direct", // simplified — full chat type resolution in future
      });
    } catch {
      // process may have exited immediately
    }

    return entry;
  }

  private async processEntry(session: SessionEntry, entry: InboxEntryWithMessage): Promise<void> {
    session.processing = true;
    session.lastActivity = Date.now();

    const inbound = toInboundMessage(entry);

    try {
      session.process.send(inbound);
    } catch (err) {
      this.config.log(`Session ${session.chatId}: failed to send message: ${err instanceof Error ? err.message : err}`);
      session.processing = false;
    }
    // processing flag is cleared when we receive a reply/ack output or on process exit
  }

  private handleOutput(sessionKey: string, msg: AgentOutput): void {
    const session = this.sessions.get(sessionKey);
    const sdk = this.config.sdk;

    switch (msg.type) {
      case "ready":
        // Process is ready — no action needed, session_init already sent
        break;

      case "reply": {
        const chatId = session?.chatId || "";
        sdk
          .sendMessage(chatId, {
            format: toMessageFormat(msg.format),
            content: msg.content,
          })
          .then(() => sdk.ack(msg.entryId))
          .then(() => {
            this.config.log(`Session ${sessionKey}: reply sent, entry ${msg.entryId} acked`);
            this.drainQueue(sessionKey);
          })
          .catch((err) => {
            this.config.log(`Session ${sessionKey}: reply/ack failed: ${err instanceof Error ? err.message : err}`);
            this.drainQueue(sessionKey);
          });
        break;
      }

      case "send": {
        if (msg.to.chatId) {
          sdk
            .sendMessage(msg.to.chatId, {
              format: toMessageFormat(msg.format),
              content: msg.content,
            })
            .catch((err) => {
              this.config.log(`Session ${sessionKey}: send failed: ${err instanceof Error ? err.message : err}`);
            });
        } else if (msg.to.agentId) {
          sdk
            .sendToAgent(msg.to.agentId, {
              format: toMessageFormat(msg.format),
              content: msg.content,
            })
            .catch((err) => {
              this.config.log(`Session ${sessionKey}: send failed: ${err instanceof Error ? err.message : err}`);
            });
        }
        break;
      }

      case "ack":
        sdk
          .ack(msg.entryId)
          .then(() => this.drainQueue(sessionKey))
          .catch((err) => {
            this.config.log(`Session ${sessionKey}: ack failed: ${err instanceof Error ? err.message : err}`);
            this.drainQueue(sessionKey);
          });
        break;

      case "renew":
        sdk.renew(msg.entryId).catch((err) => {
          this.config.log(`Session ${sessionKey}: renew failed: ${err instanceof Error ? err.message : err}`);
        });
        break;
    }
  }

  private drainQueue(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    session.processing = false;
    const next = session.messageQueue.shift();
    if (next) {
      this.processEntry(session, next);
    }
  }

  private async handlePerMessage(entry: InboxEntryWithMessage): Promise<void> {
    const inbound = toInboundMessage(entry);
    const chatId = inbound.chatId;
    const key = `msg-${entry.id}`;

    const proc = new ProcessHandle({
      command: this.config.command,
      env: this.config.env,
      onOutput: (msg) => {
        if (msg.type === "reply") {
          this.config.sdk
            .sendMessage(chatId, {
              format: toMessageFormat(msg.format),
              content: msg.content,
            })
            .then(() => this.config.sdk.ack(msg.entryId))
            .then(() => this.config.log(`Per-message ${key}: reply sent, acked`))
            .catch((err) => {
              this.config.log(`Per-message ${key}: reply/ack failed: ${err instanceof Error ? err.message : err}`);
            });
        }
      },
      onExit: (code) => {
        if (code === 0) {
          // Auto-ack if no explicit reply was sent
          this.config.sdk.ack(entry.id).catch(() => {});
        }
      },
      onError: (err) => {
        this.config.log(`Per-message ${key}: error: ${err.message}`);
      },
    });

    proc.start();

    try {
      proc.send(inbound);
      // Close stdin so the child knows input is complete
      proc.send({ type: "shutdown" });
    } catch {
      // process may have exited
    }
  }

  private evictIfNeeded(): void {
    const { max_sessions } = this.config.session;
    if (this.sessions.size < max_sessions) return;

    // Find least recently active session
    let oldest: { key: string; lastActivity: number } | null = null;
    for (const [key, session] of this.sessions) {
      if (!oldest || session.lastActivity < oldest.lastActivity) {
        oldest = { key, lastActivity: session.lastActivity };
      }
    }

    if (oldest) {
      const session = this.sessions.get(oldest.key);
      if (session) {
        this.config.log(`Session ${oldest.key}: evicted (max_sessions reached)`);
        session.process.gracefulShutdown().catch(() => {});
        this.sessions.delete(oldest.key);
      }
    }
  }

  private evictIdle(): void {
    const timeoutMs = this.config.session.idle_timeout * 1000;
    const now = Date.now();

    for (const [key, session] of this.sessions) {
      if (!session.processing && now - session.lastActivity > timeoutMs) {
        this.config.log(`Session ${key}: idle ${this.config.session.idle_timeout}s, recycling`);
        session.process.gracefulShutdown().catch(() => {});
        this.sessions.delete(key);
      }
    }
  }
}
