import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../client-connection.js";

/**
 * Regression: when an `inbox:deliver` frame fails schema validation, the
 * client must still ack the surviving top-level `entryId` so the server's
 * 300s reaper doesn't re-deliver a frame this build is guaranteed to keep
 * dropping. Without the ack, the entry round-trips through the reaper
 * `delivered → pending → delivered → drop` loop up to `maxRetries`, then
 * is silently lost. With the ack, the message is still lost (this build
 * cannot parse it), but the server state is clean and there's no spam.
 *
 * We exercise the malformed path by sending a frame whose nested `message`
 * is invalid (missing required `id` field) — `entryId` is a top-level
 * field and stays valid, which mirrors the real-world failure mode where
 * server-side enum drift breaks `message.source` but the envelope shape
 * is fine.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

type ServerSetup = {
  /** Frame to push to the client right after handshake completes. */
  malformedFrame: Record<string, unknown>;
  /** Collects entryIds the client subsequently acks via `inbox:ack`. */
  ackedEntryIds: number[];
};

function attachWss(wss: WebSocketServer, setup: ServerSetup): void {
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; entryId?: unknown };
      if (msg.type === "auth") {
        ws.send(JSON.stringify({ type: "auth:ok" }));
        return;
      }
      if (msg.type === "client:register") {
        ws.send(JSON.stringify({ type: "client:registered" }));
        // Push the malformed frame on the same socket immediately after
        // the registration ack — WS preserves frame order, so the client
        // is guaranteed to process `registered` first.
        ws.send(JSON.stringify(setup.malformedFrame));
        return;
      }
      if (msg.type === "inbox:ack" && typeof msg.entryId === "number") {
        setup.ackedEntryIds.push(msg.entryId);
      }
    });
  });
}

describe("ClientConnection — malformed inbox:deliver frame", () => {
  let httpServer: HttpServer;
  let wss: WebSocketServer;
  let serverUrl: string;

  beforeEach(async () => {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer, path: "/api/v1/agent/ws/client" });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server address");
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("best-effort acks the entryId so the server reaper doesn't retry-loop", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const setup: ServerSetup = {
      ackedEntryIds: [],
      malformedFrame: {
        type: "inbox:deliver",
        entryId: 9999,
        inboxId: "inbox_abc",
        chatId: "chat_1",
        // `message` lacks the required `id` field — inner clientMessageSchema
        // rejects, but the outer envelope is OK.
        message: { not: "a valid message" },
      },
    };
    attachWss(wss, setup);

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_malformed",
      getAccessToken: async () => token,
    });
    connection.on("error", () => {});

    await connection.connect();
    expect(connection.isConnected).toBe(true);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ack not received within 2s")), 2_000);
      const check = (): void => {
        if (setup.ackedEntryIds.includes(9999)) {
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(check, 25);
      };
      check();
    });

    expect(setup.ackedEntryIds).toEqual([9999]);

    await connection.disconnect();
  }, 10_000);

  it("does not ack when the frame lacks a usable entryId", async () => {
    // If `entryId` is absent or not a non-negative integer, there's nothing
    // safe to ack — we'd rather let the reaper repeat than ack the wrong row.
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const setup: ServerSetup = {
      ackedEntryIds: [],
      malformedFrame: {
        type: "inbox:deliver",
        entryId: "not-a-number",
        inboxId: "inbox_abc",
        chatId: "chat_1",
        message: { not: "a valid message" },
      },
    };
    attachWss(wss, setup);

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_malformed_no_entry",
      getAccessToken: async () => token,
    });
    connection.on("error", () => {});

    await connection.connect();
    // Wait long enough that any erroneous ack would have arrived.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(setup.ackedEntryIds).toEqual([]);

    await connection.disconnect();
  }, 10_000);
});
