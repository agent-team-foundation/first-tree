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
    resourceSkills: [],
    reasoningEffort: "",
    ...overrides,
  };
}

describe("buildClaudeQueryOptions", () => {
  // Stable agent identity / prompt.append ship through `<cwd>/CLAUDE.md`
  // (symlinked to AGENTS.md). Per-chat Current Chat Context is injected
  // through SDK `systemPrompt.append` so sibling chats sharing one agent home
  // cannot race on the shared briefing file.

  it("injects the runtime output contract even with no payload (no model/mcp/effort)", () => {
    // The runtime output contract does not depend on payload or chatContext, so
    // it always rides along through `systemPrompt.append`; nothing else is set.
    const opts = buildClaudeQueryOptions(undefined);
    expect(opts.systemPrompt).toEqual(expect.objectContaining({ type: "preset", preset: "claude_code" }));
    expect(opts.systemPrompt?.append).toContain("<first-tree-runtime-contract>");
    expect(opts.systemPrompt?.append).not.toContain("<first-tree-current-chat-context");
    expect("model" in opts).toBe(false);
    expect("mcpServers" in opts).toBe(false);
    expect("effort" in opts).toBe(false);
  });

  it("omits `effort` when reasoningEffort is '' (inherit the local effortLevel)", () => {
    const opts = buildClaudeQueryOptions(claudePayload({ reasoningEffort: "" }));
    expect("effort" in opts).toBe(false);
  });

  it("passes `effort` explicitly when a value is configured (overrides local)", () => {
    expect(buildClaudeQueryOptions(claudePayload({ reasoningEffort: "low" })).effort).toBe("low");
    expect(buildClaudeQueryOptions(claudePayload({ reasoningEffort: "max" })).effort).toBe("max");
  });

  it("maps model and mcpServers from the payload", () => {
    const opts = buildClaudeQueryOptions(
      claudePayload({
        model: "sonnet",
        mcpServers: [{ name: "demo", transport: "stdio", command: "echo" }],
      }),
    );
    expect(opts.model).toBe("sonnet");
    expect(opts.mcpServers).toEqual({ demo: { type: "stdio", command: "echo", args: undefined } });
  });

  it("omits model when empty (defers to SDK / local settings)", () => {
    expect("model" in buildClaudeQueryOptions(claudePayload({ model: "" }))).toBe(false);
  });

  it("appends per-chat Current Chat Context through the SDK system prompt channel", () => {
    const opts = buildClaudeQueryOptions(claudePayload(), {
      chatId: "chat-claude",
      title: "Claude routing",
      topic: "Claude routing",
      description: "testing provider prompt injection",
      participants: [{ name: "alice", displayName: "Alice", type: "human" }],
    });
    expect(opts.systemPrompt).toEqual(
      expect.objectContaining({
        type: "preset",
        preset: "claude_code",
      }),
    );
    // Both blocks ride in the append: the runtime contract first, the per-chat
    // context after it.
    const append = opts.systemPrompt?.append ?? "";
    expect(append).toContain("<first-tree-runtime-contract>");
    expect(append).toContain('<first-tree-current-chat-context format="json">');
    expect(append).toContain('"chatId": "chat-claude"');
    expect(append).toContain('"name": "alice"');
    expect(append.indexOf("<first-tree-runtime-contract>")).toBeLessThan(
      append.indexOf("<first-tree-current-chat-context"),
    );
  });
});
