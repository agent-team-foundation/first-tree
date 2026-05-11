import { describe, expect, it } from "vitest";
import { sessionEventSchema } from "../schemas/session-event.js";

describe("sessionEventSchema", () => {
  describe("tool_call", () => {
    it("parses with the minimum required fields", () => {
      const r = sessionEventSchema.safeParse({
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "Bash", args: { cmd: "ls" }, status: "ok" },
      });
      expect(r.success).toBe(true);
    });

    it("parses with durationMs and resultPreview", () => {
      const r = sessionEventSchema.safeParse({
        kind: "tool_call",
        payload: {
          toolUseId: "t1",
          name: "Bash",
          args: {},
          status: "error",
          durationMs: 12,
          resultPreview: "ok",
        },
      });
      expect(r.success).toBe(true);
    });

    it("accepts each valid status", () => {
      for (const status of ["pending", "ok", "error"] as const) {
        const r = sessionEventSchema.safeParse({
          kind: "tool_call",
          payload: { toolUseId: "t1", name: "Bash", args: {}, status },
        });
        expect(r.success).toBe(true);
      }
    });

    it("rejects an unknown status", () => {
      const r = sessionEventSchema.safeParse({
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "Bash", args: {}, status: "timeout" },
      });
      expect(r.success).toBe(false);
    });

    it("rejects a resultPreview longer than 400 chars", () => {
      const r = sessionEventSchema.safeParse({
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "Bash", args: {}, status: "ok", resultPreview: "x".repeat(401) },
      });
      expect(r.success).toBe(false);
    });

    it("rejects a negative durationMs", () => {
      const r = sessionEventSchema.safeParse({
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "Bash", args: {}, status: "ok", durationMs: -1 },
      });
      expect(r.success).toBe(false);
    });
  });

  describe("error", () => {
    it("parses a runtime error event", () => {
      const r = sessionEventSchema.safeParse({
        kind: "error",
        payload: { source: "runtime", message: "boom" },
      });
      expect(r.success).toBe(true);
    });

    it("accepts each valid source", () => {
      for (const source of ["sdk", "runtime", "tool"] as const) {
        const r = sessionEventSchema.safeParse({
          kind: "error",
          payload: { source, message: "x" },
        });
        expect(r.success).toBe(true);
      }
    });

    it("rejects an unknown source", () => {
      const r = sessionEventSchema.safeParse({
        kind: "error",
        payload: { source: "adapter", message: "boom" },
      });
      expect(r.success).toBe(false);
    });

    it("rejects a message longer than 2000 chars", () => {
      const r = sessionEventSchema.safeParse({
        kind: "error",
        payload: { source: "sdk", message: "x".repeat(2001) },
      });
      expect(r.success).toBe(false);
    });
  });

  describe("discriminated union", () => {
    it("rejects when kind doesn't match the payload shape", () => {
      const toolCallWithErrorPayload = sessionEventSchema.safeParse({
        kind: "tool_call",
        payload: { source: "sdk", message: "boom" },
      });
      const errorWithToolPayload = sessionEventSchema.safeParse({
        kind: "error",
        payload: { toolUseId: "t", name: "Bash", args: {}, status: "ok" },
      });
      expect(toolCallWithErrorPayload.success).toBe(false);
      expect(errorWithToolPayload.success).toBe(false);
    });

    it("rejects an unknown kind", () => {
      const r = sessionEventSchema.safeParse({
        kind: "warn",
        payload: { source: "sdk", message: "boom" },
      });
      expect(r.success).toBe(false);
    });
  });

  describe("assistant_text", () => {
    it("parses a minimal assistant_text event", () => {
      const r = sessionEventSchema.safeParse({
        kind: "assistant_text",
        payload: { text: "I'll check the file." },
      });
      expect(r.success).toBe(true);
    });

    it("rejects text longer than 8000 chars", () => {
      const r = sessionEventSchema.safeParse({
        kind: "assistant_text",
        payload: { text: "x".repeat(8001) },
      });
      expect(r.success).toBe(false);
    });
  });

  describe("thinking", () => {
    it("parses a thinking marker with empty payload", () => {
      const r = sessionEventSchema.safeParse({ kind: "thinking", payload: {} });
      expect(r.success).toBe(true);
    });
  });

  describe("turn_end", () => {
    it("parses success and error status", () => {
      for (const status of ["success", "error"] as const) {
        const r = sessionEventSchema.safeParse({ kind: "turn_end", payload: { status } });
        expect(r.success).toBe(true);
      }
    });

    it("rejects an unknown status", () => {
      const r = sessionEventSchema.safeParse({
        kind: "turn_end",
        payload: { status: "partial" },
      });
      expect(r.success).toBe(false);
    });
  });
});
