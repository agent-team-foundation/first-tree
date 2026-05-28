import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { buildClaudeQueryOptions } from "../handlers/claude-code.js";

function claudePayload(
  overrides: Partial<Extract<AgentRuntimeConfigPayload, { kind: "claude-code" }>> = {},
): AgentRuntimeConfigPayload {
  return {
    kind: "claude-code",
    prompt: { append: "" },
    model: "opus",
    mcpServers: [],
    env: [],
    gitRepos: [],
    reasoningEffort: "",
    ...overrides,
  };
}

describe("buildClaudeQueryOptions", () => {
  it("returns an empty slice when there is no payload and no append", () => {
    expect(buildClaudeQueryOptions(undefined, "")).toEqual({});
  });

  it("omits `effort` when reasoningEffort is '' (inherit the local effortLevel)", () => {
    const opts = buildClaudeQueryOptions(claudePayload({ reasoningEffort: "" }), "");
    expect("effort" in opts).toBe(false);
  });

  it("passes `effort` explicitly when a value is configured (overrides local)", () => {
    expect(buildClaudeQueryOptions(claudePayload({ reasoningEffort: "low" }), "").effort).toBe("low");
    expect(buildClaudeQueryOptions(claudePayload({ reasoningEffort: "max" }), "").effort).toBe("max");
  });

  it("maps model, systemPrompt append, and mcpServers from the payload", () => {
    const opts = buildClaudeQueryOptions(
      claudePayload({
        model: "sonnet",
        mcpServers: [{ name: "demo", transport: "stdio", command: "echo" }],
      }),
      "extra instructions",
    );
    expect(opts.model).toBe("sonnet");
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "extra instructions" });
    expect(opts.mcpServers).toEqual({ demo: { type: "stdio", command: "echo", args: undefined } });
  });

  it("omits model when empty (defers to SDK / local settings)", () => {
    expect("model" in buildClaudeQueryOptions(claudePayload({ model: "" }), "")).toBe(false);
  });
});
