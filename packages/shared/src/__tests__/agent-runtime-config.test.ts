import { describe, expect, it } from "vitest";
import {
  agentRuntimeConfigPayloadSchema,
  DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
  DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD,
  defaultRuntimeConfigPayload,
  deriveRepoLocalPath,
  gitRepoSchema,
  isSafeRepoLocalPath,
} from "../schemas/agent-runtime-config.js";

/**
 * Lock the Hub-side default model. This default backs two separate paths:
 *   - `server.services.agent.createAgent` seeds fresh rows from this constant.
 *   - `agentRuntimeConfigPayloadSchema.parse({})` fills the same field when a
 *     payload arrives without `model` (e.g. partial PATCH + merge).
 *
 * Dropping back to `""` would regress agents to SDK's CLI fallback — which
 * in turn depends on the operator's local `~/.claude/settings.json`. For
 * fresh agents that haven't been touched by an admin, Hub should have a
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
    // Empty string means "defer to SDK / local settings.json" — the hub
    // must not silently replace it with the default.
    const parsed = agentRuntimeConfigPayloadSchema.parse({ model: "" });
    expect(parsed.model).toBe("");
  });
});

/**
 * Codex defaults sit on a different invariant than claude-code: the Codex
 * CLI's ChatGPT-account auth rejects `gpt-5-codex` (the SDK's compile-time
 * default), so Hub leaves `model` empty and lets the CLI pick a slug that
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
    expect(defaultRuntimeConfigPayload("codex")).toMatchObject({
      kind: "codex",
      model: "",
    });
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

describe("agent runtime config — git repo localPath safety", () => {
  it("accepts safe relative local paths", () => {
    expect(gitRepoSchema.parse({ url: "https://github.com/acme/repo.git", localPath: "repos/repo-1" })).toEqual({
      url: "https://github.com/acme/repo.git",
      localPath: "repos/repo-1",
    });
  });

  it.each([
    ["/tmp/repo"],
    ["../repo"],
    ["repos/../repo"],
    ["repos//repo"],
    ["repos/./repo"],
    ["repos/repo/"],
    [" repos/repo"],
    ["repos\\repo"],
    ["C:/repo"],
    ["repo\u0000x"],
  ])("rejects unsafe localPath %j", (localPath) => {
    expect(isSafeRepoLocalPath(localPath)).toBe(false);
    expect(() => gitRepoSchema.parse({ url: "https://github.com/acme/repo.git", localPath })).toThrow();
  });

  it("preserves derived repo local path behavior for repo URLs", () => {
    expect(deriveRepoLocalPath("https://github.com/acme/repo.git")).toBe("repo");
    expect(deriveRepoLocalPath("git@github.com:acme/repo.git")).toBe("repo");
    expect(deriveRepoLocalPath("https://github.com/acme/repo.git?ref=main")).toBe("repo");
  });
});
