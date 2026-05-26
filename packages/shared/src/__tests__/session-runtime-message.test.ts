import { describe, expect, it } from "vitest";
import { RUNTIME_STATES, sessionRuntimeMessageSchema } from "../index.js";

describe("sessionRuntimeMessageSchema", () => {
  it("accepts every valid runtime state with a non-empty chatId", () => {
    for (const state of Object.values(RUNTIME_STATES)) {
      const parsed = sessionRuntimeMessageSchema.parse({ chatId: "chat-1", runtimeState: state });
      expect(parsed).toEqual({ chatId: "chat-1", runtimeState: state });
    }
  });

  it("rejects an empty chatId", () => {
    // Per-chat granularity is the whole point of this frame — an empty chatId
    // would collapse back to the lossy agent-global aggregate that #553 fixes.
    expect(() => sessionRuntimeMessageSchema.parse({ chatId: "", runtimeState: "working" })).toThrow();
  });

  it("rejects a missing chatId", () => {
    expect(() => sessionRuntimeMessageSchema.parse({ runtimeState: "working" })).toThrow();
  });

  it("rejects an unknown runtime state", () => {
    expect(() => sessionRuntimeMessageSchema.parse({ chatId: "chat-1", runtimeState: "frobnicating" })).toThrow();
  });

  it("rejects a missing runtimeState", () => {
    expect(() => sessionRuntimeMessageSchema.parse({ chatId: "chat-1" })).toThrow();
  });
});
