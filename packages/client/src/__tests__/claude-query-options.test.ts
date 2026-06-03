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
  // Per the unified-briefing redesign the SDK query no longer carries a
  // `systemPrompt.append` — agent identity / prompt.append / chat context all
  // ship through `<cwd>/CLAUDE.md` (symlinked to AGENTS.md, written by
  // `writeAgentBriefing`). buildClaudeQueryOptions therefore covers only the
  // model / mcp / reasoning-effort slice.

  it("returns an empty slice when there is no payload", () => {
    expect(buildClaudeQueryOptions(undefined)).toEqual({});
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
});
