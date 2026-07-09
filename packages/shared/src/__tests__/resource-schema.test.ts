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
    expect(canonicalizeResourceRepoUrl("github.com:Agent-Team-Foundation/First-Tree.git")).toBe(expected);
    expect(canonicalizeResourceRepoUrl("ssh://git@github.com:22/agent-team-foundation/first-tree.git")).toBe(expected);
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

  it("canonicalizes non-GitHub repo URLs and preserves non-default ports", () => {
    expect(canonicalizeResourceRepoUrl("ssh://git@git.example.com:2222/Team/Repo.git")).toBe(
      "git.example.com:2222/Team/Repo",
    );
    expect(canonicalizeResourceRepoUrl("https://gitlab.example.com/Group/Repo.git")).toBe(
      "gitlab.example.com/Group/Repo",
    );
  });

  it("rejects malformed scp-like repo URLs instead of canonicalizing unsafe shapes", () => {
    for (const value of [
      "repo",
      "git@github.com:owner/repo:bad",
      "git@github.com:owner repo",
      "git@github.com:/owner/repo",
      "git@github.com:1",
    ]) {
      expect(() => canonicalizeResourceRepoUrl(value)).toThrow();
    }

    expect(canonicalizeResourceRepoUrl("github.com:")).toBe("/");
    expect(canonicalizeResourceRepoUrl("git@github.com:22/repo")).toBe("github.com/22/repo");
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

  it("normalizes legacy nested repo local paths before validating repo bindings", () => {
    const parsed = agentResourceBindingInputSchema.parse({
      type: "repo",
      mode: "include",
      agentExtraRepo: {
        url: "https://github.com/acme/api.git",
      },
      repoRef: "main",
      repoLocalPath: "services/api",
    });

    expect(parsed.repoLocalPath).toBe("services-api");
  });

  it("rejects unsafe repo local paths on repo bindings", () => {
    const result = agentResourceBindingInputSchema.safeParse({
      type: "repo",
      mode: "include",
      agentExtraRepo: {
        url: "https://github.com/acme/api.git",
      },
      repoLocalPath: "../api",
    });

    expect(result.success).toBe(false);
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

  it("rejects binding payloads that do not match their resource type", () => {
    const invalidBindings = [
      {
        type: "repo",
        mode: "include",
        inlinePromptBody: "repo cannot carry prompt text",
      },
      {
        type: "prompt",
        mode: "include",
        agentExtraRepo: {
          url: "https://github.com/acme/api.git",
        },
      },
      {
        type: "prompt",
        mode: "include",
        inlinePromptBody: "valid prompt body",
        repoRef: "main",
      },
      {
        type: "skill",
        mode: "include",
        resourceId: "skill-1",
        repoLocalPath: "api",
      },
    ];

    for (const binding of invalidBindings) {
      expect(agentResourceBindingInputSchema.safeParse(binding).success).toBe(false);
    }
  });

  it("validates disable, replace, and include binding cardinality", () => {
    expect(
      agentResourceBindingInputSchema.parse({
        type: "repo",
        mode: "disable",
        resourceId: "team-repo-1",
      }),
    ).toMatchObject({
      type: "repo",
      mode: "disable",
      resourceId: "team-repo-1",
    });

    const invalidBindings = [
      {
        type: "repo",
        mode: "disable",
      },
      {
        type: "repo",
        mode: "disable",
        resourceId: "team-repo-1",
        replacesResourceId: "other-repo",
      },
      {
        type: "repo",
        mode: "replace",
        resourceId: "replacement-repo",
      },
      {
        type: "repo",
        mode: "replace",
        replacesResourceId: "team-repo-1",
      },
      {
        type: "repo",
        mode: "replace",
        replacesResourceId: "team-repo-1",
        resourceId: "replacement-repo",
        agentExtraRepo: {
          url: "https://github.com/acme/api.git",
        },
      },
      {
        type: "repo",
        mode: "include",
      },
      {
        type: "repo",
        mode: "include",
        resourceId: "team-repo-1",
        agentExtraRepo: {
          url: "https://github.com/acme/api.git",
        },
      },
      {
        type: "repo",
        mode: "include",
        resourceId: "team-repo-1",
        replacesResourceId: "team-repo-2",
      },
    ];

    for (const binding of invalidBindings) {
      expect(agentResourceBindingInputSchema.safeParse(binding).success).toBe(false);
    }
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
    expect(
      createTeamResourceSchema.safeParse({
        type: "mcp",
        name: "Docs",
        payload: {
          name: "docs",
          transport: "sse",
          url: "https://user:token@docs.example/mcp",
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
