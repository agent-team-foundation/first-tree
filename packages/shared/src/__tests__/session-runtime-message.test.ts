import { describe, expect, it } from "vitest";
import { sessionRuntimeMessageSchema } from "../schemas/presence.js";

// The per-(agent,chat) runtime report (client → server). Distinct from the
// agent-global `runtimeStateMessageSchema` (no chatId) — this one carries the
// chatId so the server can persist the D-axis at per-chat granularity.
describe("sessionRuntimeMessageSchema", () => {
  it("parses a valid per-chat runtime report", () => {
    const r = sessionRuntimeMessageSchema.safeParse({ chatId: "c1", runtimeState: "working" });
    expect(r.success).toBe(true);
  });

  it("accepts every runtime state value", () => {
    for (const runtimeState of ["idle", "working", "blocked", "error"] as const) {
      expect(sessionRuntimeMessageSchema.safeParse({ chatId: "c1", runtimeState }).success).toBe(true);
    }
  });

  it("rejects an unknown runtimeState", () => {
    const r = sessionRuntimeMessageSchema.safeParse({ chatId: "c1", runtimeState: "busy" });
    expect(r.success).toBe(false);
  });

  it("requires a non-empty chatId (this is what distinguishes it from the global runtime:state frame)", () => {
    expect(sessionRuntimeMessageSchema.safeParse({ runtimeState: "working" }).success).toBe(false);
    expect(sessionRuntimeMessageSchema.safeParse({ chatId: "", runtimeState: "working" }).success).toBe(false);
  });
});
