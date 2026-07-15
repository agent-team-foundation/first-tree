import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeConfigPayload } from "../schemas/agent-runtime-config.js";
import {
  agentRuntimeConfigDryRunResultSchema,
  agentRuntimeConfigPayloadSchema,
  agentRuntimeConfigSchema,
  DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
  DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD,
  DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD,
  DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD,
  defaultRuntimeConfigPayload,
  deriveRepoLocalPath,
  deriveRepoShortLabel,
  dryRunAgentRuntimeConfigSchema,
  formatRepoCoordinate,
  getRepoLocalPathSafetyError,
  gitRepoSchema,
  isRedactedEnvValue,
  isSafeRepoLocalPath,
  normalizeRepoLocalPath,
  updateAgentRuntimeConfigSchema,
} from "../schemas/agent-runtime-config.js";

/**
 * `reasoningEffort` no longer exists on every union member (the cursor variant
 * has no effort channel), so tests that assert effort behavior read it through
 * this narrowing helper instead of indexing the union.
 */
function effortOf(payload: AgentRuntimeConfigPayload): string | undefined {
  return "reasoningEffort" in payload ? payload.reasoningEffort : undefined;
}

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

/**
 * Cursor is a free-form-model, no-effort-channel provider: `model` is an exact
 * provider-native id passed through verbatim (empty = omit `--model`, Cursor
 * picks `auto` locally), and the payload deliberately has NO `reasoningEffort`
 * field — effort/fast variants live inside the model id.
 */
describe("agent runtime config — cursor variant", () => {
  it("DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD is kind=cursor with an empty model and no reasoningEffort", () => {
    expect(DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD.kind).toBe("cursor");
    expect(DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD.model).toBe("");
    expect("reasoningEffort" in DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD).toBe(false);
  });

  it("defaultRuntimeConfigPayload('cursor') selects the cursor variant", () => {
    expect(defaultRuntimeConfigPayload("cursor")).toMatchObject({ kind: "cursor", model: "" });
  });

  it("schema accepts an explicit cursor payload and any free-form exact model id", () => {
    const parsed = agentRuntimeConfigPayloadSchema.parse({
      kind: "cursor",
      model: "gpt-5.3-codex-high",
      mcpServers: [],
      env: [],
      gitRepos: [],
    });
    expect(parsed.kind).toBe("cursor");
    expect(parsed.model).toBe("gpt-5.3-codex-high");
    expect("reasoningEffort" in parsed).toBe(false);
  });

  it("a cursor payload carrying a stray reasoningEffort is stripped, not rejected", () => {
    // Zod object schemas drop unknown keys — a stale writer cannot smuggle an
    // effort field into a provider that has no effort channel.
    const parsed = agentRuntimeConfigPayloadSchema.parse({ kind: "cursor", reasoningEffort: "high" });
    expect("reasoningEffort" in parsed).toBe(false);
  });
});

describe("agent runtime config — reasoning effort", () => {
  it("claude default is '' (inherit local effortLevel); codex default is 'high'", () => {
    expect(effortOf(DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD)).toBe("");
    expect(effortOf(DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD)).toBe("high");
  });

  it("schema backfills the per-provider default when reasoningEffort is absent", () => {
    // Mirrors how legacy rows (written before this field existed) parse.
    expect(effortOf(agentRuntimeConfigPayloadSchema.parse({ kind: "claude-code" }))).toBe("");
    expect(effortOf(agentRuntimeConfigPayloadSchema.parse({ kind: "codex" }))).toBe("high");
  });

  it("a legacy row with neither kind nor reasoningEffort parses as claude-code with ''", () => {
    const parsed = agentRuntimeConfigPayloadSchema.parse({ model: "opus" });
    expect(parsed.kind).toBe("claude-code");
    expect(effortOf(parsed)).toBe("");
  });

  it("claude accepts low/medium/high/max and the '' inherit sentinel", () => {
    for (const v of ["", "low", "medium", "high", "max"]) {
      expect(effortOf(agentRuntimeConfigPayloadSchema.parse({ kind: "claude-code", reasoningEffort: v }))).toBe(v);
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

  it("codex accepts low/medium/high/xhigh/max/ultra", () => {
    for (const v of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(effortOf(agentRuntimeConfigPayloadSchema.parse({ kind: "codex", reasoningEffort: v }))).toBe(v);
    }
  });

  it("codex rejects minimal/none (incompatible with the default tools), the '' sentinel, and unknown values", () => {
    for (const v of ["minimal", "none", "", "extreme"]) {
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
  it("accepts a safe single-segment local path", () => {
    expect(gitRepoSchema.parse({ url: "https://github.com/acme/repo.git", localPath: "repo-1" })).toEqual({
      url: "https://github.com/acme/repo.git",
      localPath: "repo-1",
    });
  });

  it("coerces a legacy clean nested localPath into a joined single segment", () => {
    // Source repos must be immediate children of the workspace, but
    // `agent_configs.payload` is persisted data: a value that was legal under
    // the old (nesting-permitted) schema must still READ cleanly rather than
    // throw on every config read / agent bind. A clean nested path joins its
    // segments with `-` instead of erroring (PR #1048 — baixiaohang
    // persisted-data blocker).
    expect(gitRepoSchema.parse({ url: "https://github.com/acme/repo.git", localPath: "repos/repo-1" })).toEqual({
      url: "https://github.com/acme/repo.git",
      localPath: "repos-repo-1",
    });
    expect(gitRepoSchema.parse({ url: "https://github.com/acme/repo.git", localPath: "services/api" })).toEqual({
      url: "https://github.com/acme/repo.git",
      localPath: "services-api",
    });
  });

  it("keeps a legacy nested basename-collision config parseable (services/api + libs/api → distinct)", () => {
    // The exact class of configs nesting was useful for: two repos with the
    // same basename kept apart by directory. Joining (not taking the basename)
    // preserves the distinction (`services-api` vs `libs-api`) rather than
    // collapsing both to `api` (PR #1048 — yuezengwu collision blocker).
    const parsed = agentRuntimeConfigPayloadSchema.parse({
      kind: "claude-code",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [
        { url: "https://github.com/acme/services.git", localPath: "services/api" },
        { url: "https://github.com/acme/libs.git", localPath: "libs/api" },
      ],
      resourceSkills: [],
      reasoningEffort: "",
    });
    expect(parsed.gitRepos.map((repo) => repo.localPath)).toEqual(["services-api", "libs-api"]);
  });

  it.each([
    [""],
    ["/tmp/repo"],
    ["../repo"],
    // Only HARD-unsafe shapes are rejected (absolute, escape / dot / empty /
    // whitespace segment, backslash, control char). A *clean* nested path like
    // `repos/repo-1` is NOT here — it coerces to its basename (see the
    // coercion test above), per PR #1048.
    ["."],
    [".."],
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
    // A nested path is rejected at the single-segment check (which runs before
    // per-segment inspection), so even `repos/ repo` reports the
    // single-directory-name error rather than the whitespace one.
    expect(getRepoLocalPathSafetyError("repos/ repo")).toBe(
      "Git repo local path must be a single directory name (no '/'): source repos are immediate children of the workspace",
    );
    expect(getRepoLocalPathSafetyError("repos/repo")).toBe(
      "Git repo local path must be a single directory name (no '/'): source repos are immediate children of the workspace",
    );
    expect(getRepoLocalPathSafetyError(".")).toBe("Git repo local path must not be a dot segment");
    // A clean single segment still passes.
    expect(getRepoLocalPathSafetyError("repo-1")).toBeNull();
  });

  it("normalizeRepoLocalPath joins clean nested paths, leaves unsafe shapes untouched", () => {
    expect(normalizeRepoLocalPath("repo-1")).toBe("repo-1");
    expect(normalizeRepoLocalPath("repos/repo-1")).toBe("repos-repo-1");
    expect(normalizeRepoLocalPath("services/api")).toBe("services-api");
    // Distinct nested paths that share a basename stay distinct after joining.
    expect(normalizeRepoLocalPath("libs/api")).toBe("libs-api");
    // Hard-unsafe shapes pass through unchanged so the safety check rejects them.
    expect(normalizeRepoLocalPath("repos/../repo")).toBe("repos/../repo");
    expect(normalizeRepoLocalPath("/tmp/repo")).toBe("/tmp/repo");
    expect(normalizeRepoLocalPath(" repos/repo")).toBe(" repos/repo");
    expect(normalizeRepoLocalPath("repos//repo")).toBe("repos//repo");
    expect(normalizeRepoLocalPath("repos\\repo")).toBe("repos\\repo");
    expect(normalizeRepoLocalPath("repos/\u0000repo")).toBe("repos/\u0000repo");
    expect(normalizeRepoLocalPath("repos\\legacy/repo")).toBe("repos\\legacy/repo");
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

  it("derives a short owner/repo label", () => {
    expect(deriveRepoShortLabel("https://github.com/acme/repo")).toBe("acme/repo");
    expect(deriveRepoShortLabel("https://github.com/acme/repo.git")).toBe("acme/repo");
    expect(deriveRepoShortLabel("git@github.com:acme/repo.git")).toBe("acme/repo");
    expect(deriveRepoShortLabel("https://github.com/acme/repo.git?ref=dev")).toBe("acme/repo");
    expect(deriveRepoShortLabel("repo")).toBe("repo");
    expect(deriveRepoShortLabel("   ")).toBe("");
  });

  it("handles missing short-label split results defensively", () => {
    const originalSplit = String.prototype.split;
    const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (
      this: string,
      separator: string | RegExp | { [Symbol.split](string: string, limit?: number): string[] },
      limit?: number,
    ) {
      if (this.toString() === "force-empty-short-query" && String(separator) === "/[?#]/") {
        return [];
      }
      if (this.toString() === "force-empty-short-segments" && String(separator) === "/[/:]/") {
        return [];
      }
      return Reflect.apply(originalSplit, this, [separator, limit]);
    });

    try {
      expect(deriveRepoShortLabel("force-empty-short-query")).toBe("");
      expect(deriveRepoShortLabel("force-empty-short-segments")).toBe("");
    } finally {
      splitSpy.mockRestore();
    }
  });

  it("formats a repo coordinate, hiding default branch and default path", () => {
    // Default branch (main/master) and the derived default path are omitted.
    expect(formatRepoCoordinate({ url: "https://github.com/acme/repo" })).toBe("acme/repo");
    expect(formatRepoCoordinate({ url: "https://github.com/acme/repo", ref: "main" })).toBe("acme/repo");
    expect(formatRepoCoordinate({ url: "https://github.com/acme/repo", ref: "master" })).toBe("acme/repo");
    expect(formatRepoCoordinate({ url: "https://github.com/acme/repo", localPath: "repo" })).toBe("acme/repo");
  });

  it("formats a repo coordinate, surfacing a non-default branch and mount path", () => {
    expect(formatRepoCoordinate({ url: "https://github.com/acme/repo", ref: "staging" })).toBe("acme/repo@staging");
    expect(formatRepoCoordinate({ url: "https://github.com/acme/design-system", localPath: "ui" })).toBe(
      "acme/design-system → ui",
    );
    expect(formatRepoCoordinate({ url: "https://github.com/acme/repo", ref: "dev", localPath: "libs-x" })).toBe(
      "acme/repo@dev → libs-x",
    );
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

  it("tolerates colliding git repo local paths on read (no fatal duplicate check)", () => {
    // gitRepos is no longer writable through the config payload (the PATCH path
    // rejects it with `legacy_resource_config_disabled`), so this read-side
    // schema only ever sees gitRepos as carried-forward legacy data — and
    // `commitWrite` re-parses the whole payload on every unrelated edit. A
    // legacy localPath collision must therefore NOT throw here; runtime
    // uniqueness is enforced gracefully by the resources service's
    // `applyRepoLocalPathDedup`. See `payloadDuplicatesRefinement` (PR #1048 —
    // no pure normalization is both injective and identity-preserving on common
    // single-segment names, so tolerate-on-read is the correct contract).

    // (a) The reviewer collision class: a nested path joins to the same single
    // segment as an existing single-segment path. This previously threw on read.
    const collidingNested = agentRuntimeConfigPayloadSchema.safeParse({
      kind: "claude-code",
      gitRepos: [
        { url: "https://github.com/acme/a.git", localPath: "services/api" },
        { url: "https://github.com/acme/b.git", localPath: "services-api" },
      ],
    });
    expect(collidingNested.success).toBe(true);
    expect(collidingNested.data?.gitRepos.map((repo) => repo.localPath)).toEqual(["services-api", "services-api"]);

    // (b) Two URLs that derive the same name also read cleanly now.
    const collidingDerived = agentRuntimeConfigPayloadSchema.safeParse({
      kind: "claude-code",
      gitRepos: [{ url: "https://github.com/acme/repo.git" }, { url: "git@github.com:other/repo.git" }],
    });
    expect(collidingDerived.success).toBe(true);
    expect(collidingDerived.data?.gitRepos).toHaveLength(2);
  });

  it("reads gitRepos with empty derived paths cleanly", () => {
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
