import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCommandRunner } from "../core/context-integration/provider-driver.js";
import { ClaudeCodeContextIntegrationDriver } from "../core/context-integration/providers/claude-code.js";
import { CodexContextIntegrationDriver } from "../core/context-integration/providers/codex.js";

const temporaryRoots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
});

function fakeRunner(provider: "claude" | "codex") {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  let installed = false;
  const run: ProviderCommandRunner = (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === "--version") {
      return { stdout: provider === "claude" ? "2.1.212\n" : "codex-cli 0.144.1\n", stderr: "" };
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return {
        stdout: JSON.stringify({
          installed: installed
            ? [
                {
                  pluginId: "first-tree-context@first-tree-dev",
                  name: "first-tree-context",
                  marketplaceName: "first-tree-dev",
                  installed: true,
                  enabled: true,
                  installedPath: "/provider/cache/first-tree-context",
                },
              ]
            : [],
        }),
        stderr: "",
      };
    }
    if (args[0] === "plugin" && (args[1] === "install" || args[1] === "add")) {
      installed = true;
    }
    if (
      args[0] === "plugin" &&
      (args[1] === "uninstall" || args[1] === "remove") &&
      args[2]?.startsWith("first-tree-context@")
    ) {
      installed = false;
    }
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
      return {
        stdout: JSON.stringify({ marketplaces: [{ name: "first-tree-dev" }] }),
        stderr: "",
      };
    }
    return { stdout: "{}\n", stderr: "" };
  };
  return { run, calls };
}

describe("Context provider drivers", () => {
  it("uses Claude Code's official user-scope marketplace and Plugin lifecycle", () => {
    const fake = fakeRunner("claude");
    const driver = new ClaudeCodeContextIntegrationDriver(fake.run);
    const probe = driver.install({
      marketplaceRoot: "/tmp/marketplace",
      marketplaceName: "first-tree-dev",
      pluginName: "first-tree-context",
    });
    expect(probe).toMatchObject({ installed: true, enabled: true, compatible: true });
    expect(fake.calls.map((call) => call.args)).toContainEqual([
      "plugin",
      "marketplace",
      "add",
      "/tmp/marketplace",
      "--scope",
      "user",
    ]);
    expect(fake.calls.map((call) => call.args)).toContainEqual([
      "plugin",
      "install",
      "first-tree-context@first-tree-dev",
      "--scope",
      "user",
    ]);
  });

  it("reports Claude Hook state only when the provider-managed Plugin exists", async () => {
    const driver = new ClaudeCodeContextIntegrationDriver(fakeRunner("claude").run);

    await expect(
      driver.inspectHook({
        marketplaceName: "first-tree-dev",
        pluginName: "first-tree-context",
        cwd: "/work/repo",
        plugin: { installed: false, enabled: false },
      }),
    ).resolves.toEqual({
      trust: "unknown",
      enabled: null,
      source: "unavailable",
      issues: [],
    });
    await expect(
      driver.inspectHook({
        marketplaceName: "first-tree-dev",
        pluginName: "first-tree-context",
        cwd: "/work/repo",
        plugin: { installed: true, enabled: false },
      }),
    ).resolves.toEqual({
      trust: "provider_managed",
      enabled: false,
      source: "provider_managed",
      issues: [],
    });
  });

  it("uses Codex JSON Plugin lifecycle without bypassing native Hook trust", () => {
    const fake = fakeRunner("codex");
    const driver = new CodexContextIntegrationDriver(fake.run);
    const probe = driver.install({
      marketplaceRoot: "/tmp/marketplace",
      marketplaceName: "first-tree-dev",
      pluginName: "first-tree-context",
    });
    expect(probe).toMatchObject({
      installed: true,
      enabled: true,
      compatible: true,
    });
    expect(fake.calls.map((call) => call.args)).toContainEqual([
      "plugin",
      "add",
      "first-tree-context@first-tree-dev",
      "--json",
    ]);
    expect(fake.calls.flatMap((call) => call.args)).not.toContain("--dangerously-bypass-hook-trust");
  });

  it("reads trusted and enabled Codex SessionStart state from the provider API", async () => {
    const fake = fakeRunner("codex");
    const driver = new CodexContextIntegrationDriver(fake.run, {
      readHookState: async () => ({
        data: [
          {
            cwd: "/work/repo",
            hooks: [
              {
                pluginId: "first-tree-context@first-tree-dev",
                eventName: "sessionStart",
                handlerType: "command",
                trustStatus: "trusted",
                enabled: true,
              },
            ],
            warnings: [],
            errors: [],
          },
        ],
      }),
    });

    await expect(
      driver.inspectHook({
        marketplaceName: "first-tree-dev",
        pluginName: "first-tree-context",
        cwd: "/work/repo",
        plugin: { installed: true, enabled: true },
      }),
    ).resolves.toEqual({
      trust: "trusted",
      enabled: true,
      source: "provider_api",
      issues: [],
    });
  });

  it("distinguishes modified trust from a disabled Codex Hook", async () => {
    const fake = fakeRunner("codex");
    const driver = new CodexContextIntegrationDriver(fake.run, {
      readHookState: async () => ({
        data: [
          {
            cwd: "/work/repo",
            hooks: [
              {
                pluginId: "first-tree-context@first-tree-dev",
                eventName: "sessionStart",
                handlerType: "command",
                trustStatus: "modified",
                enabled: false,
              },
            ],
            warnings: [],
            errors: [],
          },
        ],
      }),
    });

    await expect(
      driver.inspectHook({
        marketplaceName: "first-tree-dev",
        pluginName: "first-tree-context",
        cwd: "/work/repo",
        plugin: { installed: true, enabled: true },
      }),
    ).resolves.toMatchObject({
      trust: "modified",
      enabled: false,
    });
  });

  it("resolves Codex's provider-owned cache path for safe update rollback", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "first-tree-codex-home-"));
    temporaryRoots.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    const installedPath = join(codexHome, "plugins", "cache", "first-tree-dev", "first-tree-context", "0.5.17");
    mkdirSync(installedPath, { recursive: true });
    const run: ProviderCommandRunner = (_executable, args) => {
      if (args[0] === "--version") return { stdout: "codex-cli 0.145.0\n", stderr: "" };
      return {
        stdout: JSON.stringify({
          installed: [
            {
              pluginId: "first-tree-context@first-tree-dev",
              name: "first-tree-context",
              marketplaceName: "first-tree-dev",
              version: "0.5.17",
              installed: true,
              enabled: true,
            },
          ],
        }),
        stderr: "",
      };
    };

    expect(new CodexContextIntegrationDriver(run).probe("first-tree-dev", "first-tree-context").installedPath).toBe(
      installedPath,
    );
  });

  it("resolves Claude Code's provider-owned cache path when list omits it", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "first-tree-claude-home-"));
    temporaryRoots.push(claudeHome);
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    const installedPath = join(claudeHome, "plugins", "cache", "first-tree-dev", "first-tree-context", "0.5.17");
    mkdirSync(installedPath, { recursive: true });
    const run: ProviderCommandRunner = (_executable, args) => {
      if (args[0] === "--version") return { stdout: "2.1.212\n", stderr: "" };
      return {
        stdout: JSON.stringify({
          installed: [
            {
              pluginId: "first-tree-context@first-tree-dev",
              name: "first-tree-context",
              marketplaceName: "first-tree-dev",
              version: "0.5.17",
              installed: true,
              enabled: true,
            },
          ],
        }),
        stderr: "",
      };
    };

    expect(
      new ClaudeCodeContextIntegrationDriver(run).probe("first-tree-dev", "first-tree-context").installedPath,
    ).toBe(installedPath);
  });

  it("fails closed instead of forgetting an install when the provider cannot be inspected", () => {
    const unavailable: ProviderCommandRunner = () => {
      throw new Error("provider unavailable");
    };

    expect(() =>
      new CodexContextIntegrationDriver(unavailable).uninstall({
        marketplaceName: "first-tree-dev",
        pluginName: "first-tree-context",
      }),
    ).toThrow("Codex is unavailable");
    expect(() =>
      new ClaudeCodeContextIntegrationDriver(unavailable).uninstall({
        marketplaceName: "first-tree-dev",
        pluginName: "first-tree-context",
      }),
    ).toThrow("Claude Code is unavailable");
  });
});
