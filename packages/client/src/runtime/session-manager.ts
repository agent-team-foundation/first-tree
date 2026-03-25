import type { InboxEntryWithMessage } from "@agent-hub/shared";
import type { AgentHubSDK } from "../sdk.js";
import type { SessionConfig } from "./config.js";
import type { AgentHandler, HandlerContext, HandlerFactory } from "./handler.js";

type Session = {
  chatId: string;
  handler: AgentHandler;
  lastActivity: number;
  /** Queued messages waiting for the current one to finish. */
  messageQueue: InboxEntryWithMessage[];
  /** Whether a message is currently being processed. */
  processing: boolean;
};

type SessionManagerConfig = {
  session: SessionConfig;
  handlerFactory: HandlerFactory;
  handlerConfig: Record<string, unknown>;
  agentIdentity: { agentId: string; displayName: string | null };
  sdk: AgentHubSDK;
  log: (msg: string) => void;
};

/**
 * Manages per-chat Sessions. Each (Agent, Chat) pair gets its own Handler instance.
 * Messages within the same chat are delivered serially; different chats run in parallel.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly config: SessionManagerConfig;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    this.idleTimer = setInterval(() => this.evictIdle(), 10_000);
  }

  /** Dispatch an inbox entry to the appropriate session. */
  async dispatch(entry: InboxEntryWithMessage): Promise<void> {
    const chatId = entry.chatId ?? entry.message.chatId;
    const session = this.sessions.get(chatId);

    if (session) {
      session.lastActivity = Date.now();
      if (session.processing) {
        // Queue for serial delivery within the same chat
        session.messageQueue.push(entry);
      } else {
        await this.processEntry(session, entry);
      }
    } else {
      // Evict LRU if at capacity
      this.evictIfNeeded();
      // Create new session
      const newSession = this.createSession(chatId);
      await this.processEntry(newSession, entry);
    }
  }

  /** Shut down all sessions gracefully. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const shutdowns = [...this.sessions.values()].map((s) => s.handler.shutdown?.() ?? Promise.resolve());
    await Promise.allSettled(shutdowns);
    this.sessions.clear();
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  // ---- Internal -----------------------------------------------------------

  private createSession(chatId: string): Session {
    const handler = this.config.handlerFactory(this.config.handlerConfig);

    const session: Session = {
      chatId,
      handler,
      lastActivity: Date.now(),
      messageQueue: [],
      processing: false,
    };

    this.sessions.set(chatId, session);
    this.config.log(`Session ${chatId}: created`);
    return session;
  }

  private async processEntry(session: Session, entry: InboxEntryWithMessage): Promise<void> {
    session.processing = true;
    session.lastActivity = Date.now();

    const ctx: HandlerContext = {
      agent: this.config.agentIdentity,
      sdk: this.config.sdk,
      log: (msg) => this.config.log(`Session ${session.chatId}: ${msg}`),
    };

    try {
      await session.handler.handle(entry, ctx);
    } catch (err) {
      this.config.log(`Session ${session.chatId}: handler error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      session.processing = false;
      this.drainQueue(session.chatId);
    }
  }

  private drainQueue(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;

    const next = session.messageQueue.shift();
    if (next) {
      this.processEntry(session, next).catch((err) => {
        this.config.log(`Session ${chatId}: drain error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  private evictIfNeeded(): void {
    const { max_sessions } = this.config.session;
    if (this.sessions.size < max_sessions) return;

    // Find least recently active IDLE session — skip busy ones to avoid data loss
    let oldest: { key: string; lastActivity: number } | null = null;
    for (const [key, session] of this.sessions) {
      if (session.processing || session.messageQueue.length > 0) continue;
      if (!oldest || session.lastActivity < oldest.lastActivity) {
        oldest = { key, lastActivity: session.lastActivity };
      }
    }

    if (oldest) {
      const session = this.sessions.get(oldest.key);
      if (session) {
        this.config.log(`Session ${oldest.key}: evicted (max_sessions reached)`);
        session.handler.shutdown?.().catch(() => {});
        this.sessions.delete(oldest.key);
      }
    }
    // If all sessions are busy, allow temporary overflow rather than dropping messages
  }

  private evictIdle(): void {
    const timeoutMs = this.config.session.idle_timeout * 1000;
    const now = Date.now();

    for (const [key, session] of this.sessions) {
      if (!session.processing && now - session.lastActivity > timeoutMs) {
        this.config.log(`Session ${key}: idle ${this.config.session.idle_timeout}s, recycling`);
        session.handler.shutdown?.().catch(() => {});
        this.sessions.delete(key);
      }
    }
  }
}
