import { describe, expect, it } from "vitest";
import { PROMPT_APPEND_MAX_LENGTH } from "../schemas/agent-runtime-config.js";
import {
  agentResourceBindingInputSchema,
  canonicalizeResourceRepoUrl,
  createTeamResourceSchema,
  validateEffectivePromptLength,
} from "../schemas/resource.js";

describe("resource schemas", () => {
  it("canonicalizes common GitHub repo URL forms to the same key", () => {
    const expected = "github.com/agent-team-foundation/first-tree";
    expect(canonicalizeResourceRepoUrl("https://github.com/Agent-Team-Foundation/First-Tree.git")).toBe(expected);
    expect(canonicalizeResourceRepoUrl("ssh://git@github.com/agent-team-foundation/first-tree.git")).toBe(expected);
    expect(canonicalizeResourceRepoUrl("git@github.com:agent-team-foundation/first-tree.git")).toBe(expected);
  });

  it("canonicalizes repo URLs with repeated slashes without regex backtracking", () => {
    const expected = "github.com/agent-team-foundation/first-tree";
    const repeatedSlashes = "/".repeat(5_000);
    expect(
      canonicalizeResourceRepoUrl(`https://github.com/Agent-Team-Foundation/First-Tree.git${repeatedSlashes}`),
    ).toBe(expected);
    expect(canonicalizeResourceRepoUrl(`git@github.com:agent-team-foundation/first-tree.git${repeatedSlashes}`)).toBe(
      expected,
    );
  });

  it("accepts inline prompt replace with no replacement resource id", () => {
    const parsed = agentResourceBindingInputSchema.parse({
      type: "prompt",
      mode: "replace",
      resourceId: null,
      replacesResourceId: "team-prompt-1",
      inlinePromptBody: "Use the agent-local override.",
    });
    expect(parsed).toMatchObject({
      type: "prompt",
      mode: "replace",
      resourceId: null,
      replacesResourceId: "team-prompt-1",
      inlinePromptBody: "Use the agent-local override.",
    });
  });

  it("rejects ambiguous prompt replace payloads", () => {
    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "prompt",
        mode: "replace",
        resourceId: "replacement-prompt",
        replacesResourceId: "team-prompt-1",
        inlinePromptBody: "ambiguous",
      }).success,
    ).toBe(false);
  });

  it("rejects secret-bearing HTTP MCP resources", () => {
    expect(
      createTeamResourceSchema.safeParse({
        type: "mcp",
        name: "Docs",
        payload: {
          name: "docs",
          transport: "http",
          url: "https://docs.example/mcp",
          headers: { Authorization: "Bearer secret" },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the runtime prompt budget pinned to 32,000 characters", () => {
    expect(PROMPT_APPEND_MAX_LENGTH).toBe(32_000);
    expect(validateEffectivePromptLength("x".repeat(32_000))).toBe(true);
    expect(validateEffectivePromptLength("x".repeat(32_001))).toBe(false);
  });
});
