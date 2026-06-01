import { describe, expect, it, vi } from "vitest";
import {
  agentRuntimeConfigDryRunResultSchema,
  agentRuntimeConfigPayloadSchema,
  agentRuntimeConfigSchema,
  DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
  DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD,
  DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD,
  defaultRuntimeConfigPayload,
  deriveRepoLocalPath,
  dryRunAgentRuntimeConfigSchema,
  getRepoLocalPathSafetyError,
  gitRepoSchema,
  isRedactedEnvValue,
  isSafeRepoLocalPath,
  updateAgentRuntimeConfigSchema,
} from "../schemas/agent-runtime-config.js";

/**
 * Lock the server-side default model. This default backs two separate paths:
 *   - `server.services.agent.createAgent` seeds fresh rows from this constant.
 *   - `agentRuntimeConfigPayloadSchema.parse({})` fills the same field when a
 *     payload arrives without `model` (e.g. partial PATCH + merge).
 *
 * Dropping back to `""` would regress agents to SDK's CLI fallback — which
 * in turn depends on the operator's local `~/.claude/settings.json`. For
 * fresh agents that haven't been touched by an admin, the server should have a
 * deterministic answer, so this test pins it.
 */
describe("agent runtime config — default model", () => {
  it("DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD.model is 'opus'", () => {
    expect(DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD.model).toBe("opus");
  });

  it("schema fills model='opus' when parsing an empty object", () => {
    const parsed = agentRuntimeConfigPayloadSchema.parse({});
    expect(parsed.model).toBe("opus");
  });

  it("schema preserves explicit empty string (operator opt-out)", () => {
    // Empty string means "defer to SDK / local settings.json" — the server
    // must not silently replace it with the default.
    const parsed = agentRuntimeConfigPayloadSchema.parse({ model: "" });
    expect(parsed.model).toBe("");
  });
});

/**
 * Codex defaults sit on a different invariant than claude-code: the Codex
 * CLI's ChatGPT-account auth rejects `gpt-5-codex` (the SDK's compile-time
 * default), so the server leaves `model` empty and lets the CLI pick a slug that
 * matches the user's auth mode. Pin it here so a well-meaning "set a sane
 * default" change doesn't quietly break ChatGPT-auth users.
 */
describe("agent runtime config — codex defaults", () => {
  it("DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD.model is empty (defer to CLI auth-mode default)", () => {
    expect(DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD.model).toBe("");
    expect(DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD.kind).toBe("codex");
  });

  it("defaultRuntimeConfigPayload(provider) selects the matching variant", () => {
    expect(defaultRuntimeConfigPayload("claude-code")).toMatchObject({
      kind: "claude-code",
      model: "opus",
    });
    expect(defaultRuntimeConfigPayload("claude-code-tui")).toMatchObject({
      kind: "claude-code-tui",
      model: "opus",
    });
    expect(defaultRuntimeConfigPayload("codex")).toMatchObject({
      kind: "codex",
      model: "",
    });
  });

  it("DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD is claude-code-tui with model='opus'", () => {
    expect(DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD.kind).toBe("claude-code-tui");
    expect(DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD.model).toBe("opus");
  });

  it("schema accepts an explicit claude-code-tui payload (kind discriminator)", () => {
    const parsed = agentRuntimeConfigPayloadSchema.parse({
      kind: "claude-code-tui",
      model: "sonnet",
      mcpServers: [],
      env: [],
      gitRepos: [],
    });
    expect(parsed.kind).toBe("claude-code-tui");
    expect(parsed.model).toBe("sonnet");
  });

  it("returns a distinct top-level object on each call (callers can mutate safely at top level)", () => {
    // Implementation is a shallow spread, so nested arrays still share
    // identity — pin the top-level guarantee only, since that's all
    // current callers rely on (they replace fields, not mutate them).
    const a = defaultRuntimeConfigPayload("claude-code");
    const b = defaultRuntimeConfigPayload("claude-code");
    expect(a).not.toBe(b);
    a.model = "haiku";
    expect(b.model).toBe("opus");
  });

  it("falls back to the claude-code default for unknown runtime providers at runtime", () => {
    // This intentionally bypasses the compile-time runtime provider union to
    // exercise the defensive default branch for untyped external input.
    expect(defaultRuntimeConfigPayload("future-provider" as never)).toMatchObject({
      kind: "claude-code",
      model: "opus",
    });
  });

  it("schema accepts an explicit codex payload (kind discriminator)", () => {
    const parsed = agentRuntimeConfigPayloadSchema.parse({
      kind: "codex",
      model: "gpt-5.5",
      mcpServers: [],
      env: [],
      gitRepos: [],
    });
    expect(parsed.kind).toBe("codex");
    expect(parsed.model).toBe("gpt-5.5");
  });
});

describe("agent runtime config — reasoning effort", () => {
  it("claude default is '' (inherit local effortLevel); codex default is 'high'", () => {
    expect(DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD.reasoningEffort).toBe("");
    expect(DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD.reasoningEffort).toBe("high");
  });

  it("schema backfills the per-provider default when reasoningEffort is absent", () => {
    // Mirrors how legacy rows (written before this field existed) parse.
    expect(agentRuntimeConfigPayloadSchema.parse({ kind: "claude-code" }).reasoningEffort).toBe("");
    expect(agentRuntimeConfigPayloadSchema.parse({ kind: "codex" }).reasoningEffort).toBe("high");
  });

  it("a legacy row with neither kind nor reasoningEffort parses as claude-code with ''", () => {
    const parsed = agentRuntimeConfigPayloadSchema.parse({ model: "opus" });
    expect(parsed.kind).toBe("claude-code");
    expect(parsed.reasoningEffort).toBe("");
  });

  it("claude accepts low/medium/high/max and the '' inherit sentinel", () => {
    for (const v of ["", "low", "medium", "high", "max"]) {
      expect(agentRuntimeConfigPayloadSchema.parse({ kind: "claude-code", reasoningEffort: v }).reasoningEffort).toBe(
        v,
      );
    }
  });

  it("claude rejects codex-only values (xhigh) and unknown values", () => {
    expect(agentRuntimeConfigPayloadSchema.safeParse({ kind: "claude-code", reasoningEffort: "xhigh" }).success).toBe(
      false,
    );
    expect(agentRuntimeConfigPayloadSchema.safeParse({ kind: "claude-code", reasoningEffort: "banana" }).success).toBe(
      false,
    );
  });

  it("codex accepts low/medium/high/xhigh", () => {
    for (const v of ["low", "medium", "high", "xhigh"]) {
      expect(agentRuntimeConfigPayloadSchema.parse({ kind: "codex", reasoningEffort: v }).reasoningEffort).toBe(v);
    }
  });

  it("codex rejects minimal (breaks tools), claude-only max, and the '' sentinel", () => {
    for (const v of ["minimal", "max", ""]) {
      expect(agentRuntimeConfigPayloadSchema.safeParse({ kind: "codex", reasoningEffort: v }).success).toBe(false);
    }
  });

  it("patch shape accepts reasoningEffort as a loose string (validity enforced on merge)", () => {
    expect(updateAgentRuntimeConfigSchema.parse({ expectedVersion: 1, payload: { reasoningEffort: "low" } })).toEqual({
      expectedVersion: 1,
      payload: { reasoningEffort: "low" },
    });
    // Omitted → absent from the parsed patch (merge leaves the field untouched).
    expect(
      updateAgentRuntimeConfigSchema.parse({ expectedVersion: 1, payload: { model: "sonnet" } }).payload,
    ).not.toHaveProperty("reasoningEffort");
  });
});

describe("agent runtime config — git repo localPath safety", () => {
  it("accepts safe relative local paths", () => {
    expect(gitRepoSchema.parse({ url: "https://github.com/acme/repo.git", localPath: "repos/repo-1" })).toEqual({
      url: "https://github.com/acme/repo.git",
      localPath: "repos/repo-1",
    });
  });

  it.each([
    [""],
    ["/tmp/repo"],
    ["../repo"],
    ["repos/../repo"],
    ["repos//repo"],
    ["repos/./repo"],
    ["repos/repo/"],
    [" repos/repo"],
    ["repos/ repo"],
    ["repos\\repo"],
    ["C:/repo"],
    ["repo\u0000x"],
  ])("rejects unsafe localPath %j", (localPath) => {
    expect(isSafeRepoLocalPath(localPath)).toBe(false);
    expect(() => gitRepoSchema.parse({ url: "https://github.com/acme/repo.git", localPath })).toThrow();
  });

  it("returns specific localPath safety errors", () => {
    expect(getRepoLocalPathSafetyError("")).toBe("Git repo local path must not be empty");
    expect(getRepoLocalPathSafetyError("repos/ repo")).toBe(
      "Git repo local path segments must not have leading or trailing whitespace",
    );
    expect(getRepoLocalPathSafetyError("repos/repo")).toBeNull();
  });

  it("preserves derived repo local path behavior for repo URLs", () => {
    expect(deriveRepoLocalPath("https://github.com/acme/repo.git")).toBe("repo");
    expect(deriveRepoLocalPath("git@github.com:acme/repo.git")).toBe("repo");
    expect(deriveRepoLocalPath("https://github.com/acme/repo.git?ref=main")).toBe("repo");
  });

  it("returns an empty derived path for blank or segmentless URLs", () => {
    expect(deriveRepoLocalPath("   ")).toBe("");
    expect(deriveRepoLocalPath("///")).toBe("");
  });

  it("handles a missing query-stripped segment defensively", () => {
    const originalSplit = String.prototype.split;
    const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (
      this: string,
      separator: string | RegExp | { [Symbol.split](string: string, limit?: number): string[] },
      limit?: number,
    ) {
      if (this.toString() === "force-empty-query-split" && String(separator) === "/[?#]/") {
        return [];
      }
      return Reflect.apply(originalSplit, this, [separator, limit]);
    });

    try {
      expect(deriveRepoLocalPath("force-empty-query-split")).toBe("");
    } finally {
      splitSpy.mockRestore();
    }
  });
});

describe("agent runtime config — duplicate validation", () => {
  it("rejects duplicate MCP server names case-insensitively", () => {
    const result = agentRuntimeConfigPayloadSchema.safeParse({
      kind: "claude-code",
      mcpServers: [
        { name: "GitHub", transport: "stdio", command: "github-mcp" },
        { name: "github", transport: "http", url: "https://example.com/mcp" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["mcpServers", 1, "name"],
          message: 'Duplicate MCP server name "github"',
        }),
      ]),
    );
  });

  it("rejects duplicate env keys", () => {
    const result = agentRuntimeConfigPayloadSchema.safeParse({
      kind: "claude-code",
      env: [
        { key: "API_TOKEN", value: "a" },
        { key: "API_TOKEN", value: "b", sensitive: true },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["env", 1, "key"],
          message: 'Duplicate env key "API_TOKEN"',
        }),
      ]),
    );
  });

  it("rejects duplicate git repo local paths, including derived paths", () => {
    const result = agentRuntimeConfigPayloadSchema.safeParse({
      kind: "claude-code",
      gitRepos: [{ url: "https://github.com/acme/repo.git" }, { url: "git@github.com:other/repo.git" }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["gitRepos", 1, "localPath"],
          message: 'Duplicate git repo local path "repo"',
        }),
      ]),
    );
  });

  it("ignores empty derived git repo paths during duplicate validation", () => {
    const parsed = agentRuntimeConfigPayloadSchema.parse({
      kind: "claude-code",
      gitRepos: [{ url: "   " }, { url: "https://github.com/acme/repo.git" }],
    });

    expect(parsed.gitRepos).toHaveLength(2);
  });
});

describe("agent runtime config — request and response schemas", () => {
  it("parses full config rows, update payloads, dry-run payloads, and dry-run results", () => {
    const current = agentRuntimeConfigSchema.parse({
      agentId: "agent-1",
      version: 1,
      payload: DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
      updatedAt: "2026-05-27T00:00:00.000Z",
      updatedBy: "user-1",
    });

    expect(updateAgentRuntimeConfigSchema.parse({ expectedVersion: 1, payload: { model: "sonnet" } })).toEqual({
      expectedVersion: 1,
      payload: { model: "sonnet" },
    });
    expect(dryRunAgentRuntimeConfigSchema.parse({ payload: { env: [{ key: "TOKEN", value: "***" }] } })).toEqual({
      payload: { env: [{ key: "TOKEN", value: "***", sensitive: false }] },
    });
    expect(
      agentRuntimeConfigDryRunResultSchema.parse({
        current,
        next: DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
        diff: [{ path: "model", op: "replace", before: "opus", after: "sonnet" }],
      }),
    ).toMatchObject({ current, diff: [{ path: "model", op: "replace" }] });
  });
});

describe("agent runtime config — redacted env values", () => {
  it("detects the redacted placeholder exactly", () => {
    expect(isRedactedEnvValue("***")).toBe(true);
    expect(isRedactedEnvValue("secret")).toBe(false);
  });
});
