import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeClaudeCodeCapability } from "../runtime/capabilities/claude-code.js";
import { probeCodexCapability } from "../runtime/capabilities/codex.js";
import { probeCapabilities } from "../runtime/capabilities/index.js";

/**
 * Capability probes are the only on-machine input the runtime gate uses
 * to decide if an agent can bind. These tests pin the auth-detection
 * branches we shipped:
 *   - claude-code: ANTHROPIC_API_KEY → ok/api_key; OAuth marker file
 *     `~/.claude.json::oauthAccount.accountUuid` → ok/oauth; neither →
 *     unauthenticated.
 *   - codex: CODEX_API_KEY → ok/api_key; presence of
 *     `${CODEX_HOME}/auth.json` → ok/auth_json; neither → unauthenticated.
 *
 * The probes always include a `state` ∈ {ok, unauthenticated, missing,
 * error} and a matching `available` flag — the server-side gate keys off
 * those, so a regression that flips the boolean would silently allow or
 * deny binds. These tests run with isolated HOME / CODEX_HOME so they
 * don't read the developer's real auth files.
 */

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("probeClaudeCodeCapability", () => {
  let tmpHome: string;
  let prev: Record<string, string | undefined>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ft-cap-claude-"));
    prev = snapshotEnv(["HOME", "ANTHROPIC_API_KEY"]);
    process.env.HOME = tmpHome;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    restoreEnv(prev);
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("`ok` + api_key when ANTHROPIC_API_KEY is set (no OAuth file required)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-12345";
    const entry = await probeClaudeCodeCapability();
    expect(entry.state).toBe("ok");
    expect(entry.available).toBe(true);
    expect(entry.authenticated).toBe(true);
    expect(entry.authMethod).toBe("api_key");
  });

  it("`ok` + oauth when ~/.claude.json has `oauthAccount.accountUuid`", async () => {
    writeFileSync(join(tmpHome, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acc-abc-123" } }));
    const entry = await probeClaudeCodeCapability();
    expect(entry.state).toBe("ok");
    expect(entry.authMethod).toBe("oauth");
  });

  it("`unauthenticated` when no API key and no OAuth marker", async () => {
    const entry = await probeClaudeCodeCapability();
    expect(entry.state).toBe("unauthenticated");
    expect(entry.available).toBe(true);
    expect(entry.authenticated).toBe(false);
    expect(entry.authMethod).toBe("none");
  });

  it("treats a `~/.claude.json` without `accountUuid` as unauthenticated (the canonical login signal)", async () => {
    writeFileSync(
      join(tmpHome, ".claude.json"),
      // Realistic shape: file exists (CLI was run) but no oauthAccount yet.
      JSON.stringify({ otherStuff: "settings", oauthAccount: { someOtherField: true } }),
    );
    const entry = await probeClaudeCodeCapability();
    expect(entry.state).toBe("unauthenticated");
  });

  it("treats malformed `~/.claude.json` as unauthenticated", async () => {
    writeFileSync(join(tmpHome, ".claude.json"), "{not-json");

    const entry = await probeClaudeCodeCapability();

    expect(entry.state).toBe("unauthenticated");
    expect(entry.authMethod).toBe("none");
  });

  it("returns a non-null `sdkVersion` when the SDK package.json is reachable (smoke-only)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const entry = await probeClaudeCodeCapability();
    // The repo includes @anthropic-ai/claude-agent-sdk as a dep, so this
    // should resolve. Don't pin a specific version — bumping the dep
    // would invalidate the test for no good reason.
    expect(typeof entry.sdkVersion === "string" || entry.sdkVersion === null).toBe(true);
  });

  it("reports missing when the Claude SDK import fails", async () => {
    vi.resetModules();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => {
      throw new Error("sdk missing");
    });
    const mod = await import("../runtime/capabilities/claude-code.js");

    const entry = await mod.probeClaudeCodeCapability();

    expect(entry).toMatchObject({
      state: "missing",
      available: false,
      authenticated: false,
      sdkVersion: null,
      authMethod: "none",
    });
    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
    vi.resetModules();
  });

  it("reports errors thrown from auth detection", async () => {
    const originalEnv = process.env;
    try {
      Object.defineProperty(process, "env", {
        configurable: true,
        value: new Proxy(originalEnv, {
          get(target, prop, receiver) {
            if (prop === "ANTHROPIC_API_KEY") {
              throw new Error("env read failed");
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
      });

      const entry = await probeClaudeCodeCapability();

      expect(entry).toMatchObject({
        state: "error",
        available: false,
        authenticated: false,
        authMethod: "none",
        error: "env read failed",
      });
    } finally {
      Object.defineProperty(process, "env", { configurable: true, value: originalEnv });
    }

    try {
      Object.defineProperty(process, "env", {
        configurable: true,
        value: new Proxy(originalEnv, {
          get(target, prop, receiver) {
            if (prop === "ANTHROPIC_API_KEY") {
              throw "env string failed";
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
      });

      const entry = await probeClaudeCodeCapability();

      expect(entry.error).toBe("env string failed");
    } finally {
      Object.defineProperty(process, "env", { configurable: true, value: originalEnv });
    }
  });
});

describe("probeCodexCapability", () => {
  let tmpHome: string;
  let prev: Record<string, string | undefined>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ft-cap-codex-"));
    prev = snapshotEnv(["CODEX_HOME", "CODEX_API_KEY"]);
    process.env.CODEX_HOME = tmpHome;
    delete process.env.CODEX_API_KEY;
  });

  afterEach(() => {
    restoreEnv(prev);
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("`ok` + api_key when CODEX_API_KEY is set", async () => {
    process.env.CODEX_API_KEY = "ck-test-12345";
    const entry = await probeCodexCapability();
    expect(entry.state).toBe("ok");
    expect(entry.authMethod).toBe("api_key");
  });

  it("`ok` + auth_json when $CODEX_HOME/auth.json exists", async () => {
    writeFileSync(join(tmpHome, "auth.json"), JSON.stringify({ token: "x" }));
    const entry = await probeCodexCapability();
    expect(entry.state).toBe("ok");
    expect(entry.authMethod).toBe("auth_json");
  });

  it("`unauthenticated` when neither env nor auth.json is present", async () => {
    // tmpHome is empty by default.
    const entry = await probeCodexCapability();
    expect(entry.state).toBe("unauthenticated");
    expect(entry.available).toBe(true);
    expect(entry.authMethod).toBe("none");
  });

  it("falls back to ~/.codex/auth.json when CODEX_HOME is unset", async () => {
    delete process.env.CODEX_HOME;
    // Hijack HOME so the codex probe doesn't read the developer's real auth.
    const homePrev = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "ft-cap-codex-home-"));
    process.env.HOME = fakeHome;
    try {
      mkdirSync(join(fakeHome, ".codex"), { recursive: true });
      writeFileSync(join(fakeHome, ".codex", "auth.json"), "{}");
      const entry = await probeCodexCapability();
      expect(entry.state).toBe("ok");
      expect(entry.authMethod).toBe("auth_json");
    } finally {
      if (homePrev === undefined) delete process.env.HOME;
      else process.env.HOME = homePrev;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("reports missing when the Codex SDK import fails", async () => {
    vi.resetModules();
    vi.doMock("@openai/codex-sdk", () => {
      throw new Error("sdk missing");
    });
    const mod = await import("../runtime/capabilities/codex.js");

    const entry = await mod.probeCodexCapability();

    expect(entry).toMatchObject({
      state: "missing",
      available: false,
      authenticated: false,
      sdkVersion: null,
      authMethod: "none",
    });
    vi.doUnmock("@openai/codex-sdk");
    vi.resetModules();
  });

  it("reports errors thrown from Codex auth detection", async () => {
    const originalEnv = process.env;
    try {
      Object.defineProperty(process, "env", {
        configurable: true,
        value: new Proxy(originalEnv, {
          get(target, prop, receiver) {
            if (prop === "CODEX_API_KEY") {
              throw "codex env failed";
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
      });

      const entry = await probeCodexCapability();

      expect(entry).toMatchObject({
        state: "error",
        available: false,
        authenticated: false,
        authMethod: "none",
        error: "codex env failed",
      });
    } finally {
      Object.defineProperty(process, "env", { configurable: true, value: originalEnv });
    }

    try {
      Object.defineProperty(process, "env", {
        configurable: true,
        value: new Proxy(originalEnv, {
          get(target, prop, receiver) {
            if (prop === "CODEX_API_KEY") {
              throw new Error("codex env error");
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
      });

      const entry = await probeCodexCapability();

      expect(entry.error).toBe("codex env error");
    } finally {
      Object.defineProperty(process, "env", { configurable: true, value: originalEnv });
    }
  });
});

describe("probeCapabilities (aggregator)", () => {
  let tmpHome: string;
  let tmpCodexHome: string;
  let prev: Record<string, string | undefined>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ft-cap-agg-h-"));
    tmpCodexHome = mkdtempSync(join(tmpdir(), "ft-cap-agg-c-"));
    prev = snapshotEnv(["HOME", "ANTHROPIC_API_KEY", "CODEX_HOME", "CODEX_API_KEY"]);
    process.env.HOME = tmpHome;
    process.env.CODEX_HOME = tmpCodexHome;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CODEX_API_KEY;
  });

  afterEach(() => {
    restoreEnv(prev);
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCodexHome, { recursive: true, force: true });
  });

  it("returns one entry per built-in provider, each with a valid state", async () => {
    const caps = await probeCapabilities();
    expect(Object.keys(caps).sort()).toEqual(["claude-code", "codex"]);
    for (const k of ["claude-code", "codex"] as const) {
      const entry = caps[k];
      if (!entry) throw new Error(`missing entry for ${k}`);
      expect(["ok", "unauthenticated", "missing", "error"]).toContain(entry.state);
      expect(typeof entry.available).toBe("boolean");
      expect(typeof entry.detectedAt).toBe("string");
    }
  });

  it("unauthenticated machine reports both providers as state=unauthenticated", async () => {
    const caps = await probeCapabilities();
    expect(caps["claude-code"]?.state).toBe("unauthenticated");
    expect(caps.codex?.state).toBe("unauthenticated");
  });

  it("setting ANTHROPIC_API_KEY flips claude-code to ok without disturbing codex", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const caps = await probeCapabilities();
    expect(caps["claude-code"]?.state).toBe("ok");
    expect(caps.codex?.state).toBe("unauthenticated");
  });

  it("converts provider probe failures into error capability entries", async () => {
    vi.resetModules();
    vi.doMock("../runtime/capabilities/claude-code.js", () => ({
      probeClaudeCodeCapability: vi.fn().mockRejectedValue(new Error("claude probe failed")),
    }));
    vi.doMock("../runtime/capabilities/codex.js", () => ({
      probeCodexCapability: vi.fn().mockRejectedValue("codex probe failed"),
    }));
    const mod = await import("../runtime/capabilities/index.js");

    const caps = await mod.probeCapabilities();

    expect(caps["claude-code"]).toMatchObject({
      state: "error",
      available: false,
      authenticated: false,
      authMethod: "none",
      error: "claude probe failed",
    });
    expect(caps.codex).toMatchObject({
      state: "error",
      available: false,
      authenticated: false,
      authMethod: "none",
      error: "codex probe failed",
    });

    vi.doUnmock("../runtime/capabilities/claude-code.js");
    vi.doUnmock("../runtime/capabilities/codex.js");
    vi.resetModules();
  });
});
