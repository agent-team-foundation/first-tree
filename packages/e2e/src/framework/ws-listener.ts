import { WebSocket } from "ws";

/**
 * Minimal `agent:ws` client used by e2e tests to listen for server pushes
 * (mainly `inbox:deliver` frames) without spawning the real CLI. Mirrors
 * the handshake order enforced by `packages/server/src/api/agent/ws-client.ts`:
 *
 *   1. open WS at `${serverBaseUrl}/api/v1/agent/ws`
 *   2. send `{type:"auth", token}` → wait for `{type:"auth:ok"}`
 *   3. send `{type:"client:register", clientId}` → wait for `{type:"client:registered"}`
 *   4. (optional) send `{type:"agent:bind", agentId, runtimeType}` →
 *      `{type:"agent:bound"}` / `{type:"agent:bind:rejected"}`
 *
 * The listener exposes a `waitFor(predicate, timeoutMs?)` so tests can do
 * `listener.waitFor((f) => f.type === "inbox:deliver" && f.chatId === id)`
 * without re-implementing the frame-buffer dance every time.
 */

export type WsFrame = Record<string, unknown> & { type: string };

export type ConnectOptions = {
  serverBaseUrl: string;
  accessToken: string;
  clientId: string;
  /** Bind one or more agents after `client:register` succeeds. */
  bindAgents?: { agentId: string; runtimeType?: string }[];
  /** Per-step (auth, register, bind) timeout. Default 5000ms. */
  stepTimeoutMs?: number;
};

export type WsListener = {
  /** Wait for a frame matching `predicate`, ignoring frames sent earlier. */
  waitFor: (predicate: (f: WsFrame) => boolean, timeoutMs?: number) => Promise<WsFrame>;
  /** Frames received so far (in arrival order). Mutated as new ones land. */
  readonly frames: ReadonlyArray<WsFrame>;
  close: () => Promise<void>;
};

export async function connectWsListener(opts: ConnectOptions): Promise<WsListener> {
  const wsUrl = `${opts.serverBaseUrl.replace(/^http/, "ws")}/api/v1/agent/ws/client`;
  const stepTimeoutMs = opts.stepTimeoutMs ?? 5_000;

  const ws = new WebSocket(wsUrl);
  const frames: WsFrame[] = [];
  const waiters: Array<{ predicate: (f: WsFrame) => boolean; resolve: (f: WsFrame) => void }> = [];

  ws.on("message", (data) => {
    let f: WsFrame;
    try {
      const parsed = JSON.parse(data.toString());
      if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return;
      f = parsed as WsFrame;
    } catch {
      return;
    }
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w?.predicate(f)) {
        waiters.splice(i, 1);
        w.resolve(f);
      }
    }
  });

  // Open
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), stepTimeoutMs);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  function send(frame: WsFrame): void {
    ws.send(JSON.stringify(frame));
  }

  function waitFor(predicate: (f: WsFrame) => boolean, timeoutMs?: number): Promise<WsFrame> {
    // Scan already-buffered frames first.
    for (const f of frames) if (predicate(f)) return Promise.resolve(f);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      waiters.push(w);
      const t = setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(
          new Error(
            `ws waitFor timeout after ${timeoutMs ?? stepTimeoutMs}ms — frames seen: ${frames.map((f) => f.type).join(", ")}`,
          ),
        );
      }, timeoutMs ?? stepTimeoutMs);
      const wrapped = w.resolve;
      w.resolve = (f) => {
        clearTimeout(t);
        wrapped(f);
      };
    });
  }

  send({ type: "auth", token: opts.accessToken });
  await waitFor((f) => f.type === "auth:ok" || f.type === "auth:rejected");
  const authResult = frames[frames.length - 1];
  if (authResult?.type === "auth:rejected") {
    ws.close();
    throw new Error(`ws auth rejected: ${JSON.stringify(authResult)}`);
  }

  send({ type: "client:register", clientId: opts.clientId });
  const registered = await waitFor((f) => f.type === "client:registered" || f.type === "client:register:rejected");
  if (registered.type === "client:register:rejected") {
    ws.close();
    throw new Error(`ws client:register rejected: ${JSON.stringify(registered)}`);
  }

  for (const a of opts.bindAgents ?? []) {
    send({ type: "agent:bind", agentId: a.agentId, runtimeType: a.runtimeType ?? "claude-code" });
    const bindResult = await waitFor(
      (f) =>
        (f.type === "agent:bound" && f.agentId === a.agentId) ||
        (f.type === "agent:bind:rejected" && f.agentId === a.agentId),
    );
    if (bindResult.type === "agent:bind:rejected") {
      ws.close();
      throw new Error(`ws agent:bind rejected for ${a.agentId}: ${JSON.stringify(bindResult)}`);
    }
  }

  return {
    waitFor,
    get frames() {
      return frames;
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}
