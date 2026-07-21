import { describe, expect, it } from "vitest";
import {
  encodeProviderRetryEventMessage,
  parseProviderRetryEventMessage,
  statusReasonFromProviderRetryEvent,
} from "../schemas/provider-retry.js";
import { currentTurnNarrationSchema, sessionEventSchema } from "../schemas/session-event.js";

describe("sessionEventSchema", () => {
  describe("currentTurnNarrationSchema", () => {
    it("accepts complete uncapped current-turn text", () => {
      const text = "x".repeat(20_000);
      expect(currentTurnNarrationSchema.parse({ agentId: "agent-1", afterSeq: 4, latestSeq: 9, text })).toEqual({
        agentId: "agent-1",
        afterSeq: 4,
        latestSeq: 9,
        text,
      });
    });

    it("rejects an empty narration or invalid sequence boundary", () => {
      expect(
        currentTurnNarrationSchema.safeParse({ agentId: "agent-1", afterSeq: 0, latestSeq: 1, text: "" }).success,
      ).toBe(false);
      expect(
        currentTurnNarrationSchema.safeParse({ agentId: "agent-1", afterSeq: -1, latestSeq: 0, text: "x" }).success,
      ).toBe(false);
    });
  });

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
        payload: { source: "bogus", message: "boom" },
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

    it("round-trips provider retry payloads through the encoded bridge", () => {
      const message = encodeProviderRetryEventMessage({
        event: "provider_retry_scheduled",
        provider: "codex",
        scope: "provider_turn",
        category: "transient_transport",
        reasonCode: "provider_transient_transport",
        attempt: 1,
        maxAttempts: 3,
        retryMode: "foreground",
        delayMs: 1000,
        replaySafety: "pre_visible",
        userSeverity: "info",
      });
      const parsed = parseProviderRetryEventMessage(message);
      expect(parsed).toMatchObject({
        event: "provider_retry_scheduled",
        provider: "codex",
        scope: "provider_turn",
        category: "transient_transport",
      });
      expect(parsed ? statusReasonFromProviderRetryEvent(parsed) : null).toMatchObject({
        kind: "retrying",
        label: "Retrying provider",
      });
    });

    it("ignores malformed provider retry bridge messages", () => {
      expect(parseProviderRetryEventMessage("provider.retry: nope")).toBeNull();
      expect(parseProviderRetryEventMessage("plain sdk failure")).toBeNull();
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
    it("parses legacy and chunk-boundary-aware assistant_text events", () => {
      const legacy = sessionEventSchema.safeParse({
        kind: "assistant_text",
        payload: { text: "I'll check the file." },
      });
      const current = sessionEventSchema.safeParse({
        kind: "assistant_text",
        payload: { text: "continued", continuation: true },
      });
      expect(legacy.success).toBe(true);
      expect(current.success).toBe(true);
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

  describe("context_tree_usage", () => {
    it("parses a full payload with a node path", () => {
      const r = sessionEventSchema.safeParse({
        kind: "context_tree_usage",
        payload: {
          purpose: "design_decision",
          treeRepoUrl: "https://github.com/example/tree",
          nodePath: "members/Gandy2025/NODE.md",
        },
      });
      expect(r.success).toBe(true);
    });

    it("accepts a null nodePath", () => {
      const r = sessionEventSchema.safeParse({
        kind: "context_tree_usage",
        payload: { purpose: "design_decision", treeRepoUrl: null, nodePath: null },
      });
      expect(r.success).toBe(true);
    });

    it("defaults a MISSING nodePath to null (pre-P0 client deploy-skew tolerance)", () => {
      // A ≤0.14.8 client still emits the old `{ purpose, treeRepoUrl }` shape.
      // Without `.default(null)` the server's strict appendEvent parse would
      // reject and drop the event; the default normalises absence to null.
      const r = sessionEventSchema.safeParse({
        kind: "context_tree_usage",
        payload: { purpose: "design_decision", treeRepoUrl: null },
      });
      expect(r.success).toBe(true);
      if (r.success && r.data.kind === "context_tree_usage") {
        expect(r.data.payload.nodePath).toBeNull();
      }
    });

    it("rejects a non-design_decision purpose", () => {
      const r = sessionEventSchema.safeParse({
        kind: "context_tree_usage",
        payload: { purpose: "file_read", treeRepoUrl: null, nodePath: null },
      });
      expect(r.success).toBe(false);
    });
  });

  describe("turn_end", () => {
    it("parses success and error status", () => {
      for (const status of ["success", "error"] as const) {
        const r = sessionEventSchema.safeParse({ kind: "turn_end", payload: { status } });
        expect(r.success).toBe(true);
      }
    });

    it("parses an optional stable turn completion id", () => {
      const r = sessionEventSchema.safeParse({
        kind: "turn_end",
        payload: { status: "success", turnCompletionId: "inbox:101" },
      });
      expect(r.success).toBe(true);
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
