import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { ClientConnection } from "../client-connection.js";
import { AgentSlot } from "../runtime/agent-slot.js";
import type { AgentHandler, SessionContext, SessionMessage } from "../runtime/handler.js";
import { SessionRegistry } from "../runtime/session-registry.js";

/**
 * Production-shaped Reset regression: real `ClientConnection` frames on a real
 * socket, a real `AgentSlot` + `SessionManager` + inbox delivery coordinator,
 * and a server model that owns the terminate/finalize handshake and the
 * inbox recover / redelivery / no-progress path.
 *
 * The unit-level tests emit `session:command:finalized` straight into an
 * emitter or call `releaseParkedResetFenceRecovery` directly, which cannot
 * catch a wire-shape or negotiation regression. This one drives the whole
 * chain end to end:
 *
 *  1. a failed Reset flush plus repeated intervening delivery makes zero
 *     recover / provider / ACK traffic and never opens the no-progress circuit;
 *  2. a genuine same-socket Reset retry acks `applied` BEFORE the server
 *     finalizes, and the exact `finalized` arrives only after that commit;
 *  3. exactly one recovery follows, and the intervening row enters a fresh
 *     nonce-derived session and ACKs once — on the same socket, no reconnect;
 *  4. a stale/duplicate ref and a foreign-agent ref can neither release early
 *     nor stall the chat, and a lost finalize path converges through the
 *     operator's real recovery — a retried Reset with a NEW terminate ref;
 *  5. a clean Reset with no preexisting debt still fences the window between
 *     `applied` and `finalized`, so a row arriving there parks instead of
 *     entering the session the Reset just destroyed;
 *  6. an applied Reset the server could NOT finalize (the reactivation race)
 *     still reaches a terminal wire outcome: the receipted `aborted`
 *     disposition lifts exactly that generation once, so the fenced row enters
 *     a fresh nonce-derived session instead of sitting behind a fence forever.
 */

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const INBOX_ID = `inbox_${AGENT_ID}`;
const CHAT_ID = "chat-reset-wire";
/** Same shape as the server's inbox recovery circuit breaker. */
const NO_PROGRESS_LIMIT = 2;

type InboxRow = {
  entryId: number;
  messageId: string;
  content: string;
  status: "pending" | "delivered" | "acked";
};

type AppliedFrame = { ref: string; applied: boolean };
type ReceiptFrame = { ref: string; ackRef: string; released: boolean };
type AbortReceiptFrame = ReceiptFrame;

/**
 * Minimal but route-faithful First Tree server: the HTTP surface `AgentSlot`
 * needs for bring-up, plus the client WS data plane. Terminate/finalize is
 * driven explicitly by the test so delivery loss and ordering are exact.
 */
class FakeServer {
  readonly rows = new Map<number, InboxRow>();
  /** Ordered trace of the Reset handshake as the SERVER observed it. */
  readonly trace: string[] = [];
  readonly applied: AppliedFrame[] = [];
  readonly receipts: ReceiptFrame[] = [];
  readonly abortReceipts: AbortReceiptFrame[] = [];
  readonly recovers: string[] = [];
  registerCapabilities: Record<string, unknown> = {};
  connections = 0;
  noProgressCircuitOpen = false;
  /** Flip off to model a server build that predates the composite v1 protocol. */
  advertiseSessionResetV1 = true;
  /** Finalize signals the test drops in transit, keyed by terminate ref. */
  readonly lostFinalizeRefs = new Set<string>();

  private http!: Server;
  private wss!: WebSocketServer;
  private socket: WsSocket | null = null;
  private lastResetSignature: string | null = null;
  private consecutiveNoProgressResets = 0;

  baseUrl = "";

  async listen(): Promise<void> {
    this.http = createServer((req, res) => this.handleHttp(req, res));
    await new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", () => resolve()));
    const address = this.http.address();
    if (!address || typeof address === "string") throw new Error("expected tcp address");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    this.wss = new WebSocketServer({ server: this.http, path: "/api/v1/agent/ws/client" });
    this.wss.on("connection", (socket) => {
      this.connections++;
      this.socket = socket;
      socket.on("message", (raw) => this.handleFrame(socket, String(raw)));
    });
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  send(frame: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame));
  }

  seed(row: Omit<InboxRow, "status">): void {
    this.rows.set(row.entryId, { ...row, status: "pending" });
  }

  /** Push a pending/delivered row to the client (redelivery keeps the id). */
  deliver(entryId: number): void {
    const row = this.rows.get(entryId);
    if (!row) throw new Error(`unknown row ${entryId}`);
    row.status = "delivered";
    this.send({
      type: "inbox:deliver",
      entryId: row.entryId,
      inboxId: INBOX_ID,
      chatId: CHAT_ID,
      message: {
        id: row.messageId,
        chatId: CHAT_ID,
        senderId: "user-1",
        format: "text",
        content: row.content,
        metadata: {},
        inReplyTo: null,
        source: null,
        createdAt: new Date().toISOString(),
        configVersion: 1,
        recipientMode: "full",
        precedingMessages: [],
      },
    });
  }

  sendTerminate(ref?: string): void {
    this.send({ type: "session:terminate", agentId: AGENT_ID, chatId: CHAT_ID, ...(ref ? { ref } : {}) });
  }

  /** Post-`finalizeTerminatedSession` signal on the exact client route. */
  sendFinalized(ref: string, ackRef: string, agentId: string = AGENT_ID): void {
    if (this.lostFinalizeRefs.has(ref)) {
      // Production loss shape: the frame (or its PG wake) never reaches the
      // client, so this Reset's HTTP request fails with 503 and the operator
      // retries with a brand-new terminate ref.
      this.trace.push("finalized:lost");
      return;
    }
    this.trace.push("finalized:sent");
    this.send({
      type: "session:command:finalized",
      ref,
      ackRef,
      agentId,
      chatId: CHAT_ID,
      command: "session:terminate",
      state: "evicted",
    });
  }

  /**
   * The other terminal disposition: the client applied truthfully but the
   * server could not commit the eviction (a re-activated row, a refused route,
   * a rolled-back cleanup), so it lifts that exact generation instead. Same
   * exact-route, same-ref, own-rendezvous shape as `sendFinalized`.
   */
  sendAborted(
    ref: string,
    ackRef: string,
    reason: "reactivated" | "route_refused" | "cleanup_failed" = "reactivated",
    agentId: string = AGENT_ID,
  ): void {
    this.trace.push("aborted:sent");
    this.send({
      type: "session:command:aborted",
      ref,
      ackRef,
      agentId,
      chatId: CHAT_ID,
      command: "session:terminate",
      reason,
    });
  }

  ackedRows(): number[] {
    return [...this.rows.values()].filter((row) => row.status === "acked").map((row) => row.entryId);
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "";
    const json = (body: unknown) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (url.startsWith("/api/v1/agent/me")) {
      json({
        uuid: AGENT_ID,
        inboxId: INBOX_ID,
        status: "online",
        displayName: "Wire Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      });
      return;
    }
    if (url.startsWith("/api/v1/agent/config")) {
      json({
        agentId: AGENT_ID,
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: "tester",
        payload: {
          kind: "claude-code",
          prompt: { append: "" },
          model: "opus",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
          reasoningEffort: "",
        },
      });
      return;
    }
    if (url.startsWith("/api/v1/agent/chats/active-runtime-ids")) {
      json({ chatIds: [CHAT_ID] });
      return;
    }
    if (url.startsWith("/api/v1/agent/context-tree/info")) {
      json({ repo: null });
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: url } }));
  }

  private handleFrame(socket: WsSocket, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = msg.type as string;
    switch (type) {
      case "auth":
        // Welcome BEFORE auth:ok — the client answers auth:ok with
        // client:register and can only declare the finalize half honestly
        // once it has seen this advertisement.
        socket.send(
          JSON.stringify({
            type: "server:welcome",
            serverCommandVersion: "1.0.0",
            serverTimeMs: Date.now(),
            capabilities: {
              wsInboxDeliver: true,
              wsInboxAckConfirm: true,
              wsSessionEventConfirm: true,
              ...(this.advertiseSessionResetV1 ? { wsSessionResetV1: true } : {}),
            },
          }),
        );
        socket.send(JSON.stringify({ type: "auth:ok" }));
        return;
      case "client:register":
        this.registerCapabilities = (msg.wireCapabilities as Record<string, unknown>) ?? {};
        socket.send(JSON.stringify({ type: "client:registered" }));
        return;
      case "agent:bind":
        socket.send(
          JSON.stringify({
            type: "agent:bound",
            ref: msg.ref,
            agentId: msg.agentId,
            displayName: "Wire Agent",
            agentType: "agent",
            runtimeSessionToken: "runtime-token-wire",
          }),
        );
        return;
      case "inbox:ack": {
        const entryId = msg.entryId as number;
        const row = this.rows.get(entryId);
        if (row) row.status = "acked";
        this.trace.push(`ack:${entryId}`);
        if (typeof msg.ref === "string") {
          socket.send(JSON.stringify({ type: "inbox:ack:accepted", entryId, ref: msg.ref, disposition: "acked" }));
        }
        return;
      }
      case "inbox:recover": {
        this.trace.push("recover");
        this.recovers.push(String(msg.ref));
        const stuck = [...this.rows.values()].filter((row) => row.status === "delivered");
        const signature = stuck.map((row) => row.entryId).join(",");
        this.consecutiveNoProgressResets =
          this.lastResetSignature === signature ? this.consecutiveNoProgressResets + 1 : 1;
        this.lastResetSignature = signature;
        if (this.consecutiveNoProgressResets > NO_PROGRESS_LIMIT) {
          this.noProgressCircuitOpen = true;
          socket.send(
            JSON.stringify({
              type: "inbox:recover:rejected",
              ref: msg.ref,
              agentId: msg.agentId,
              chatId: msg.chatId,
              reason: "no_progress",
            }),
          );
          return;
        }
        for (const row of stuck) row.status = "pending";
        socket.send(
          JSON.stringify({
            type: "inbox:recover:accepted",
            ref: msg.ref,
            agentId: msg.agentId,
            chatId: msg.chatId,
            resetCount: stuck.length,
            unackedOutstanding: [...this.rows.values()].filter((row) => row.status !== "acked").length,
          }),
        );
        // Redelivery rides the notify loop after the reset transaction
        // commits, so it lands on a later tick than the confirmation.
        setTimeout(() => {
          for (const row of stuck) this.deliver(row.entryId);
        }, 20);
        return;
      }
      case "inbox:fence-probe":
        socket.send(
          JSON.stringify({
            type: "inbox:fence-probe:accepted",
            ref: msg.ref,
            agentId: msg.agentId,
            chatId: msg.chatId,
            settledMessageIds: [],
          }),
        );
        return;
      case "session:event":
        if (typeof msg.ref === "string") {
          socket.send(JSON.stringify({ type: "session:event:accepted", ref: msg.ref, agentId: msg.agentId }));
        }
        return;
      case "session:command:applied":
        this.trace.push(`applied:${msg.applied === true}`);
        this.applied.push({ ref: msg.ref as string, applied: msg.applied === true });
        return;
      case "session:command:finalized:ack":
        this.trace.push(`receipt:${msg.released === true}`);
        this.receipts.push({
          ref: msg.ref as string,
          ackRef: msg.ackRef as string,
          released: msg.released === true,
        });
        return;
      case "session:command:aborted:ack":
        this.trace.push(`abort-receipt:${msg.released === true}`);
        this.abortReceipts.push({
          ref: msg.ref as string,
          ackRef: msg.ackRef as string,
          released: msg.released === true,
        });
        return;
      default:
        return;
    }
  }
}

describe("Reset finalize handshake — wire level", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  type Harness = {
    server: FakeServer;
    home: string;
    starts: Array<{ messageId: string; freshStartNonce: string | undefined }>;
    /** Messages queued into an already-live provider session. */
    injects: string[];
    /** Gate the handler's shutdown so a delivery can land mid-drain. */
    setShutdownGate: (gate: Promise<void> | null) => void;
  };

  async function bootWireHarness(options: { advertiseSessionResetV1?: boolean } = {}): Promise<Harness> {
    const home = mkdtempSync(join(tmpdir(), "ft-reset-wire-"));
    const previousHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = home;
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.FIRST_TREE_HOME;
      else process.env.FIRST_TREE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    });

    const server = new FakeServer();
    server.advertiseSessionResetV1 = options.advertiseSessionResetV1 ?? true;
    await server.listen();
    cleanups.push(() => server.close());

    const starts: Array<{ messageId: string; freshStartNonce: string | undefined }> = [];
    const injects: string[] = [];
    let shutdownGate: Promise<void> | null = null;
    const handler: AgentHandler = {
      start: async (message: SessionMessage, ctx: SessionContext, token) => {
        starts.push({ messageId: message.id, freshStartNonce: ctx.freshStartNonce?.() });
        token?.processingStarted(message);
        await token?.complete(message, { status: "success", terminal: true });
        await ctx.finishTurn(message, { status: "success", terminal: true });
        return { sessionId: `session-${message.id}`, route: { kind: "owned" as const, mode: "queued" as const } };
      },
      resume: async (message: SessionMessage | undefined, sessionId: string, ctx: SessionContext, token) => {
        if (!message) return { sessionId: sessionId, route: { kind: "owned" as const, mode: "queued" as const } };
        token?.processingStarted(message);
        await token?.complete(message, { status: "success", terminal: true });
        await ctx.finishTurn(message, { status: "success", terminal: true });
        return { sessionId: sessionId, route: { kind: "owned" as const, mode: "queued" as const } };
      },
      inject: (messages) => {
        for (const message of Array.isArray(messages) ? messages : [messages]) injects.push(message.id);
        return { kind: "owned", mode: "queued" };
      },
      suspend: async () => {},
      shutdown: async () => {
        if (shutdownGate) await shutdownGate;
      },
    };

    const connection = new ClientConnection({
      serverUrl: server.baseUrl,
      clientId: "client-reset-wire",
      getAccessToken: async () => "access-token",
    });
    await connection.connect();
    cleanups.push(() => connection.disconnect());

    const slot = new AgentSlot({
      name: "wire-agent",
      agentId: AGENT_ID,
      serverUrl: server.baseUrl,
      type: "codex",
      handlerFactory: () => handler,
      session: {
        idle_timeout: 3600,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 86_400,
        defer_suspend_on_subprocess: false,
      },
      concurrency: 2,
      clientConnection: connection,
    });
    await slot.start();
    cleanups.push(() => slot.stop("test end"));

    return {
      server,
      home,
      starts,
      injects,
      setShutdownGate: (gate) => {
        shutdownGate = gate;
      },
    };
  }

  it("drives park → applied → finalized → receipt → one recovery over a real socket", async () => {
    const { server, home, starts, setShutdownGate } = await bootWireHarness();

    // The whole Reset contract was negotiated on this socket as one version.
    expect(server.registerCapabilities).toEqual({ wsSessionResetV1: true });

    // ── Baseline turn: the chat has a live provider session ────────────────
    server.seed({ entryId: 1, messageId: "msg-baseline", content: "hello" });
    server.deliver(1);
    await vi.waitFor(() => expect(server.ackedRows()).toContain(1), { timeout: 5_000 });
    expect(starts).toHaveLength(1);

    // ── 1. Failed Reset flush + repeated intervening delivery ──────────────
    const flushBoom = new Error("disk full");
    vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw flushBoom;
    });
    server.sendTerminate("ref-a");
    await vi.waitFor(() => expect(server.applied).toHaveLength(1), { timeout: 5_000 });
    expect(server.applied[0]).toEqual({ ref: "ref-a", applied: false });

    // The server would answer that HTTP Reset with 503 — no finalize, so the
    // client must hold everything that arrives behind the fence.
    server.seed({ entryId: 2, messageId: "msg-intervening", content: "queued during reset" });
    server.deliver(2);
    server.deliver(2);
    server.deliver(2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.recovers).toHaveLength(0);
    expect(server.ackedRows()).toEqual([1]);
    expect(starts).toHaveLength(1);
    expect(server.noProgressCircuitOpen).toBe(false);

    // ── 2. Genuine same-socket retry: applied BEFORE the server finalizes ──
    server.send({ type: "session:suspend", agentId: AGENT_ID, chatId: CHAT_ID });
    server.sendTerminate("ref-b");
    await vi.waitFor(() => expect(server.applied).toHaveLength(2), { timeout: 5_000 });
    expect(server.applied[1]).toEqual({ ref: "ref-b", applied: true });
    expect(server.recovers).toHaveLength(0);

    server.trace.push("finalize-commit");
    server.sendFinalized("ref-b", "ack-b");

    // ── 3. Receipt, then exactly one recovery into a fresh session ─────────
    await vi.waitFor(() => expect(server.ackedRows()).toContain(2), { timeout: 5_000 });
    expect(server.receipts).toEqual([{ ref: "ref-b", ackRef: "ack-b", released: true }]);
    expect(server.recovers).toHaveLength(1);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.messageId).toBe("msg-intervening");
    expect(server.noProgressCircuitOpen).toBe(false);
    // Same socket throughout — recovery must not need a reconnect.
    expect(server.connections).toBe(1);
    // The recovered row entered a fresh nonce-derived session.
    const registry = JSON.parse(readFileSync(join(home, "data", "sessions", "wire-agent.json"), "utf-8")) as {
      entries: Record<string, { claudeSessionId: string }>;
      freshStartNonces?: Record<string, string>;
    };
    const nonce = registry.freshStartNonces?.[CHAT_ID];
    expect(nonce).toBeTruthy();
    expect(starts[1]?.freshStartNonce).toBe(nonce);
    expect(starts[0]?.freshStartNonce).not.toBe(nonce);
    // The Reset dropped the old mapping durably before the fresh start.
    expect(registry.entries[CHAT_ID]).toBeUndefined();

    const traceAfterReset = server.trace.filter((event) => !event.startsWith("ack:") && event !== "applied:false");
    // The apply-ack precedes the server's finalize commit; recovery and the
    // receipt both follow the finalized frame, never the local apply alone.
    expect(traceAfterReset).toEqual(["applied:true", "finalize-commit", "finalized:sent", "recover", "receipt:true"]);

    // ── 4a. Duplicate + foreign finalized frames ───────────────────────────
    // A duplicate for the SAME generation is idempotent, not stale: this
    // client really did release that fence, so the retrying server gets a
    // truthful `released: true` — but nothing recovers twice.
    server.sendFinalized("ref-b", "ack-b-late");
    server.sendFinalized("ref-b", "ack-foreign", "99999999-2222-4333-8444-555555555555");
    await vi.waitFor(() => expect(server.receipts).toHaveLength(2), { timeout: 5_000 });
    expect(server.receipts[1]).toEqual({ ref: "ref-b", ackRef: "ack-b-late", released: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The foreign agent's frame is not this slot's to answer, and neither
    // stale frame may drive another recovery.
    expect(server.receipts).toHaveLength(2);
    expect(server.recovers).toHaveLength(1);

    // ── 4b. Lost finalize on Reset C, operator retries Reset with a NEW ref ─
    // Production shape: the first finalize path is lost, that HTTP attempt
    // ends in 503, and the operator presses Reset again — a fresh terminate
    // ref, never a replay of the finalized frame for the dead one.
    server.lostFinalizeRefs.add("ref-c");
    let releaseShutdown: (() => void) | undefined;
    setShutdownGate(
      new Promise<void>((resolve) => {
        releaseShutdown = resolve;
      }),
    );
    server.sendTerminate("ref-c");
    // Land an intervening delivery inside the drain so the fence has debt.
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.seed({ entryId: 4, messageId: "msg-after-lost-signal", content: "queued behind lost signal" });
    server.deliver(4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseShutdown?.();
    setShutdownGate(null);
    await vi.waitFor(() => expect(server.applied).toHaveLength(3), { timeout: 5_000 });
    expect(server.applied[2]).toEqual({ ref: "ref-c", applied: true });

    // The finalize signal for ref-c never lands (HTTP 503 for the operator):
    // the row stays parked, and the client must NOT recover, ACK, or start a
    // provider session on its own.
    server.sendFinalized("ref-c", "ack-c");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.trace).toContain("finalized:lost");
    expect(server.recovers).toHaveLength(1);
    expect(server.receipts).toHaveLength(2);
    expect(server.ackedRows()).not.toContain(4);
    expect(server.noProgressCircuitOpen).toBe(false);

    // The retried Reset carries a new terminate ref. It applies against the
    // already-terminated chat and arms the current generation, so ITS
    // finalize releases the row parked by the lost attempt — exactly once,
    // on the same socket.
    server.sendTerminate("ref-d");
    await vi.waitFor(() => expect(server.applied).toHaveLength(4), { timeout: 5_000 });
    expect(server.applied[3]).toEqual({ ref: "ref-d", applied: true });
    expect(server.recovers).toHaveLength(1);

    server.sendFinalized("ref-d", "ack-d");
    await vi.waitFor(() => expect(server.ackedRows()).toContain(4), { timeout: 5_000 });
    expect(server.receipts.at(-1)).toEqual({ ref: "ref-d", ackRef: "ack-d", released: true });
    expect(server.recovers).toHaveLength(2);
    expect(server.noProgressCircuitOpen).toBe(false);
    expect(server.connections).toBe(1);

    // A late finalize for the abandoned generation is answered honestly and
    // recovers nothing: the retry's generation superseded it.
    server.lostFinalizeRefs.delete("ref-c");
    server.sendFinalized("ref-c", "ack-c-late");
    await vi.waitFor(() => expect(server.receipts.at(-1)?.ackRef).toBe("ack-c-late"), { timeout: 5_000 });
    expect(server.receipts.at(-1)).toEqual({ ref: "ref-c", ackRef: "ack-c-late", released: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.recovers).toHaveLength(2);
    expect(server.noProgressCircuitOpen).toBe(false);
  }, 30_000);

  it("releases an applied Reset the server could not finalize, through the receipted abort", async () => {
    const { server, home, starts, injects, setShutdownGate } = await bootWireHarness();

    // ── Baseline turn: the chat has a live provider session ────────────────
    server.seed({ entryId: 1, messageId: "msg-abort-baseline", content: "hello" });
    server.deliver(1);
    await vi.waitFor(() => expect(server.ackedRows()).toContain(1), { timeout: 5_000 });
    expect(starts).toHaveLength(1);

    // ── The Reset applies truthfully, with a row landing during the drain ──
    // Production shape for the server's reactivation race: the addressed row
    // arrives inside the ACK/finalize window, which is exactly what flips the
    // session row back to `active` and makes `finalizeTerminatedSession` refuse
    // to evict. The client has already destroyed its provider session by then.
    let releaseShutdown: (() => void) | undefined;
    setShutdownGate(
      new Promise<void>((resolve) => {
        releaseShutdown = resolve;
      }),
    );
    server.sendTerminate("ref-abort");
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.seed({ entryId: 2, messageId: "msg-reactivating", content: "arrived during the ack window" });
    server.deliver(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseShutdown?.();
    setShutdownGate(null);
    await vi.waitFor(() => expect(server.applied).toHaveLength(1), { timeout: 5_000 });
    expect(server.applied[0]).toEqual({ ref: "ref-abort", applied: true });

    // ── Before the exact abort: absolutely nothing moves ───────────────────
    // The server is about to answer the operator 409. Without a terminal wire
    // outcome the chat would sit here forever — that is the regression.
    server.deliver(2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.recovers).toHaveLength(0);
    expect(starts).toHaveLength(1);
    expect(injects).toEqual([]);
    expect(server.ackedRows()).toEqual([1]);
    expect(server.noProgressCircuitOpen).toBe(false);

    // ── A stale/foreign/unknown ref must not lift this generation ──────────
    server.sendAborted("ref-not-mine", "ack-stale");
    server.sendAborted("ref-abort", "ack-foreign", "reactivated", "99999999-2222-4333-8444-555555555555");
    await vi.waitFor(() => expect(server.abortReceipts).toHaveLength(1), { timeout: 5_000 });
    expect(server.abortReceipts[0]).toEqual({ ref: "ref-not-mine", ackRef: "ack-stale", released: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The foreign agent's frame is not this slot's to answer at all.
    expect(server.abortReceipts).toHaveLength(1);
    expect(server.recovers).toHaveLength(0);
    expect(server.ackedRows()).toEqual([1]);

    // ── The exact abort releases once, into a fresh nonce-derived session ──
    server.sendAborted("ref-abort", "ack-abort");
    await vi.waitFor(() => expect(server.ackedRows()).toContain(2), { timeout: 5_000 });
    expect(server.abortReceipts.at(-1)).toEqual({ ref: "ref-abort", ackRef: "ack-abort", released: true });
    expect(server.recovers).toHaveLength(1);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.messageId).toBe("msg-reactivating");
    // No extra Pause/Reset/reconnect was needed, and repeated fenced
    // redelivery never opened the server's no-progress circuit.
    expect(server.applied).toHaveLength(1);
    expect(server.connections).toBe(1);
    expect(server.noProgressCircuitOpen).toBe(false);

    // Abort lifted the generation; it did NOT restore the retired provider
    // session. The recovered row entered a fresh nonce-derived identity with the
    // old mapping still gone.
    const registry = JSON.parse(readFileSync(join(home, "data", "sessions", "wire-agent.json"), "utf-8")) as {
      entries: Record<string, { claudeSessionId: string }>;
      freshStartNonces?: Record<string, string>;
    };
    const nonce = registry.freshStartNonces?.[CHAT_ID];
    expect(nonce).toBeTruthy();
    expect(starts[1]?.freshStartNonce).toBe(nonce);
    expect(starts[0]?.freshStartNonce).not.toBe(nonce);
    expect(injects).toEqual([]);

    const traceAfterReset = server.trace.filter((event) => !event.startsWith("ack:"));
    expect(traceAfterReset).toEqual([
      "applied:true",
      "aborted:sent",
      "aborted:sent",
      "abort-receipt:false",
      "aborted:sent",
      "recover",
      "abort-receipt:true",
    ]);

    // ── A duplicate abort is idempotent; a finalized frame for the same
    //    already-released generation is too — neither recovers twice ────────
    server.sendAborted("ref-abort", "ack-abort-late");
    await vi.waitFor(() => expect(server.abortReceipts).toHaveLength(3), { timeout: 5_000 });
    expect(server.abortReceipts.at(-1)).toEqual({ ref: "ref-abort", ackRef: "ack-abort-late", released: true });
    server.sendFinalized("ref-abort", "ack-crossed");
    await vi.waitFor(() => expect(server.receipts).toHaveLength(1), { timeout: 5_000 });
    expect(server.receipts[0]).toEqual({ ref: "ref-abort", ackRef: "ack-crossed", released: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.recovers).toHaveLength(1);
    expect(server.noProgressCircuitOpen).toBe(false);

    // ── A later genuine Reset still works, and the abandoned ref cannot lift
    //    the NEW generation ───────────────────────────────────────────────
    server.send({ type: "session:suspend", agentId: AGENT_ID, chatId: CHAT_ID });
    server.sendTerminate("ref-after-abort");
    await vi.waitFor(() => expect(server.applied).toHaveLength(2), { timeout: 5_000 });
    expect(server.applied[1]).toEqual({ ref: "ref-after-abort", applied: true });
    server.seed({ entryId: 3, messageId: "msg-after-abort", content: "queued behind the new generation" });
    server.deliver(3);
    server.sendAborted("ref-abort", "ack-superseded");
    await vi.waitFor(() => expect(server.abortReceipts).toHaveLength(4), { timeout: 5_000 });
    expect(server.abortReceipts.at(-1)).toEqual({ ref: "ref-abort", ackRef: "ack-superseded", released: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.recovers).toHaveLength(1);
    expect(server.ackedRows()).not.toContain(3);

    server.sendFinalized("ref-after-abort", "ack-after-abort");
    await vi.waitFor(() => expect(server.ackedRows()).toContain(3), { timeout: 5_000 });
    expect(server.receipts.at(-1)).toEqual({
      ref: "ref-after-abort",
      ackRef: "ack-after-abort",
      released: true,
    });
    expect(server.recovers).toHaveLength(2);
    expect(server.connections).toBe(1);
    expect(server.noProgressCircuitOpen).toBe(false);
  }, 30_000);

  it("fails a ref'd Reset closed against a server without the v1 Reset protocol", async () => {
    const { server, starts, injects } = await bootWireHarness({ advertiseSessionResetV1: false });

    // The client advertised no Reset capability at all — not even the legacy
    // apply-only flag, which an old server would have read as consent — so a
    // correctly-gated server would not even offer Reset here.
    expect(server.registerCapabilities).toEqual({});

    server.seed({ entryId: 1, messageId: "msg-skew-baseline", content: "hello" });
    server.deliver(1);
    await vi.waitFor(() => expect(server.ackedRows()).toContain(1), { timeout: 5_000 });

    // An old server that offers it anyway must be refused BEFORE the local
    // teardown — otherwise the session dies behind a fence nothing will lift.
    server.sendTerminate("ref-skew");
    await vi.waitFor(() => expect(server.applied).toHaveLength(1), { timeout: 5_000 });
    expect(server.applied[0]).toEqual({ ref: "ref-skew", applied: false });

    // Nothing was destroyed or parked: the next delivery still reaches the
    // same live provider session instead of sitting behind a Reset fence.
    server.seed({ entryId: 2, messageId: "msg-skew-after", content: "still working" });
    server.deliver(2);
    await vi.waitFor(() => expect(injects).toContain("msg-skew-after"), { timeout: 5_000 });
    expect(server.recovers).toHaveLength(0);
    expect(server.receipts).toHaveLength(0);
    expect(starts.map((entry) => entry.messageId)).toEqual(["msg-skew-baseline"]);
  }, 30_000);

  it("fences a clean Reset's post-apply window even with nothing parked at apply time", async () => {
    const { server, home, starts, injects } = await bootWireHarness();

    // Baseline turn, fully settled: this Reset starts from zero debt, which
    // is the ordinary operator case and used to skip the fence entirely.
    server.seed({ entryId: 1, messageId: "msg-clean-baseline", content: "hello" });
    server.deliver(1);
    await vi.waitFor(() => expect(server.ackedRows()).toContain(1), { timeout: 5_000 });
    expect(starts).toHaveLength(1);

    server.send({ type: "session:suspend", agentId: AGENT_ID, chatId: CHAT_ID });
    server.sendTerminate("ref-clean");
    await vi.waitFor(() => expect(server.applied).toHaveLength(1), { timeout: 5_000 });
    expect(server.applied[0]).toEqual({ ref: "ref-clean", applied: true });

    // The server has not finalized yet: the old session is already gone, so a
    // row arriving now must park — no provider route, no recovery, no ACK.
    server.seed({ entryId: 2, messageId: "msg-in-post-apply-window", content: "arrived after applied" });
    server.deliver(2);
    server.deliver(2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(starts).toHaveLength(1);
    expect(injects).toEqual([]);
    expect(server.recovers).toHaveLength(0);
    expect(server.ackedRows()).toEqual([1]);
    expect(server.noProgressCircuitOpen).toBe(false);

    // The exact finalized ref lifts the fence: one recovery, and the parked
    // row settles in a fresh nonce-derived session.
    server.sendFinalized("ref-clean", "ack-clean");
    await vi.waitFor(() => expect(server.ackedRows()).toContain(2), { timeout: 5_000 });
    expect(server.receipts).toEqual([{ ref: "ref-clean", ackRef: "ack-clean", released: true }]);
    expect(server.recovers).toHaveLength(1);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.messageId).toBe("msg-in-post-apply-window");
    expect(server.noProgressCircuitOpen).toBe(false);
    expect(server.connections).toBe(1);

    const registry = JSON.parse(readFileSync(join(home, "data", "sessions", "wire-agent.json"), "utf-8")) as {
      freshStartNonces?: Record<string, string>;
    };
    expect(starts[1]?.freshStartNonce).toBe(registry.freshStartNonces?.[CHAT_ID]);
    expect(starts[1]?.freshStartNonce).not.toBe(starts[0]?.freshStartNonce);
  }, 30_000);
});
