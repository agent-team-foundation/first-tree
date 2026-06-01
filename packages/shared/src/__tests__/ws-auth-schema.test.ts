import { describe, expect, it } from "vitest";
import { serverWelcomeFrameSchema } from "../schemas/ws-auth.js";

describe("serverWelcomeFrameSchema", () => {
  it("accepts a well-formed frame", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "0.9.2",
      serverTimeMs: 1_713_000_000_000,
    });
    expect(res.success).toBe(true);
  });

  it("passes unknown fields through so future server versions can extend the frame", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "1.0.0",
      serverTimeMs: 0,
      channel: "beta",
      featureHints: { sessionPersistence: true },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      // unknown field survives — critical for forward-compat
      expect((res.data as { channel?: string }).channel).toBe("beta");
    }
  });

  it("rejects wrong discriminator", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "auth:ok",
      serverCommandVersion: "0.9.2",
      serverTimeMs: 0,
    });
    expect(res.success).toBe(false);
  });

  it("rejects empty serverCommandVersion", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "",
      serverTimeMs: 0,
    });
    expect(res.success).toBe(false);
  });

  it("rejects negative serverTimeMs", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "0.9.2",
      serverTimeMs: -1,
    });
    expect(res.success).toBe(false);
  });

  it("accepts a capabilities block advertising wsInboxDeliver", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "1.0.0",
      serverTimeMs: 1_713_000_000_000,
      capabilities: { wsInboxDeliver: true, wsInboxAckConfirm: true },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.capabilities?.wsInboxDeliver).toBe(true);
      expect(res.data.capabilities?.wsInboxAckConfirm).toBe(true);
    }
  });

  it("accepts an empty capabilities object and defaults WS capabilities to false", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "1.0.0",
      serverTimeMs: 0,
      capabilities: {},
    });
    expect(res.success).toBe(true);
    if (res.success) {
      // The field default + .partial() inflate `{}` → `{wsInboxDeliver:false}`,
      // matching the server-side behaviour: unset == "no opt-in".
      expect(res.data.capabilities?.wsInboxDeliver).toBe(false);
      expect(res.data.capabilities?.wsInboxAckConfirm).toBe(false);
    }
  });

  it("accepts a welcome with no capabilities key at all (legacy server)", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "0.9.2",
      serverTimeMs: 0,
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.capabilities).toBeUndefined();
    }
  });
});
