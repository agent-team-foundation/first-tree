import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { endWsConnectionSpan, setWsConnectionAttrs, startWsConnectionSpan, withWsMessageSpan } from "../ws-tracing.js";

// When telemetry is disabled (default in unit tests — no initTelemetry call),
// every ws-tracing function is supposed to be a no-op. A bug here would crash
// the entire WS layer, not just the trace data — so these smoke tests exist
// precisely to catch the regression where someone forgets the null check.

describe("ws-tracing (telemetry disabled)", () => {
  const fakeSocket = {} as unknown as WebSocket;

  it("startWsConnectionSpan is a no-op when tracing is off", () => {
    expect(() => startWsConnectionSpan(fakeSocket, { clientId: "c1" })).not.toThrow();
  });

  it("setWsConnectionAttrs on an untracked socket is a no-op", () => {
    expect(() => setWsConnectionAttrs(fakeSocket, { "organization.id": "org1" })).not.toThrow();
  });

  it("endWsConnectionSpan on an untracked socket is a no-op", () => {
    expect(() => endWsConnectionSpan(fakeSocket, 1000)).not.toThrow();
  });

  it("withWsMessageSpan runs the handler unwrapped", async () => {
    let ran = false;
    const result = await withWsMessageSpan(fakeSocket, "heartbeat", {}, async () => {
      ran = true;
      return "ok";
    });
    expect(ran).toBe(true);
    expect(result).toBe("ok");
  });

  it("withWsMessageSpan propagates thrown errors", async () => {
    await expect(
      withWsMessageSpan(fakeSocket, "session:event", {}, async () => {
        throw new Error("handler blew up");
      }),
    ).rejects.toThrow("handler blew up");
  });

  it("lifecycle start→setAttrs→end does not throw for sockets without spans", () => {
    startWsConnectionSpan(fakeSocket, { clientId: "c1" });
    setWsConnectionAttrs(fakeSocket, { "member.id": "m1" });
    endWsConnectionSpan(fakeSocket, 1000);
    // Second end should also be safe (idempotent no-op on cleared WeakMap entry)
    endWsConnectionSpan(fakeSocket);
  });
});
