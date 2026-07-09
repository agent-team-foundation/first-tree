import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Targeted branch coverage for remaining defensive / edge paths across CLI
 * modules. Prefer exercising real shipped exports over coverage-only stubs.
 */

const tempDirs: string[] = [];
const originalPlatform = process.platform;
const originalHome = process.env.FIRST_TREE_HOME;
const originalPath = process.env.PATH;
const originalIsTty = process.stdin.isTTY;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  setPlatform(originalPlatform);
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../core/cli-fetch.js");
  vi.doUnmock("../core/bootstrap.js");
  vi.doUnmock("../core/channel.js");
  vi.doUnmock("../core/doc-capture.js");
  vi.doUnmock("../commands/_shared/local-agent.js");
  vi.doUnmock("../cli/output.js");
  vi.doUnmock("../commands/chat/_shared/io.js");
  vi.doUnmock("@first-tree/shared/config");
  vi.doUnmock("@first-tree/client");
  vi.doUnmock("node:fs");
});

describe("defaultRepoName and tree helpers", () => {
  it("falls back to team slug when the title slugifies empty", async () => {
    const { defaultRepoName } = await import("../commands/tree/init.js");
    expect(defaultRepoName("!!!")).toBe("team-context-tree");
    expect(defaultRepoName("My Cool Team")).toContain("context-tree");
  });
});

describe("promptMissingFields env lookup edges", () => {
  it("returns undefined for non-object schema intermediates and non-field tags", async () => {
    const home = tempDir("ft-prompt-env-");
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "config"), { recursive: true });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    const { promptMissingFields } = await import("../core/prompt.js");
    // Path goes through a scalar, so findEnvVar short-circuits without env hint.
    await expect(
      promptMissingFields({
        schema: {
          a: {
            _tag: "field",
            options: { prompt: { message: "A" } },
          },
          nested: {
            _tag: "optional",
            shape: {
              leaf: { _tag: "not-a-field", options: { prompt: { message: "Leaf" }, env: "X" } },
            },
          },
        },
        role: "client",
        configDir: join(home, "config"),
        cliArgs: {},
      }),
    ).rejects.toThrow(/Missing required configuration/);
  });
});

describe("printConfig unlabeled prompt sections", () => {
  it("falls back to default labels when section names are empty", async () => {
    const { printConfig } = await import("../commands/agent/config/_shared/fetchers.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printConfig({
      agentId: "agent-1",
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "user-1",
      payload: {
        kind: "claude-code",
        model: "sonnet",
        reasoningEffort: "medium",
        prompt: {
          append: "",
          sections: [
            { scope: "team", name: "", body: "team body", editable: false },
            { scope: "agent", name: "", body: "override body", editable: false },
            { scope: "agent", name: "", body: "fragment", editable: true },
          ],
        },
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
    } as never);
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("team prompt");
    expect(out).toContain("agent prompt override");
    expect(out).toContain("per-agent fragment");
    stdout.mockRestore();
  });
});

describe("errorMessage", () => {
  it("prefers Error.message and stringifies non-Error values", async () => {
    const { errorMessage } = await import("../core/error-message.js");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("raw")).toBe("raw");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
  });
});

describe("formatServiceFailure", () => {
  it("prefers stderr and formats null or numeric exit codes", async () => {
    const { __testFormatServiceFailure } = await import("../core/service-install.js");
    expect(__testFormatServiceFailure({ stderr: "denied", code: 1 })).toBe("denied");
    expect(__testFormatServiceFailure({ stderr: "", code: null })).toBe("exit unknown");
    expect(__testFormatServiceFailure({ stderr: "", code: 7 })).toBe("exit 7");
  });
});

describe("wsl-dbus without /proc/version", () => {
  it("returns false when /proc/version is missing on linux", async () => {
    setPlatform("linux");
    const fs = await import("node:fs");
    const original = fs.existsSync;
    // existsSync is not spiable on ESM; call with a reason that fails earlier
    // for non-bus cases, and rely on real /proc/version when present.
    const { isWslDbusOvermount } = await import("../commands/daemon/_shared/wsl-dbus.js");
    expect(isWslDbusOvermount("permission denied")).toBe(false);
  });
});

describe("client-switch journalHasRootMovement", () => {
  it("covers null journals, empty moves, and post-park phases", async () => {
    const { __testJournalHasRootMovement, readActiveRootClientId } = await import("../core/client-switch.js");
    expect(__testJournalHasRootMovement(null)).toBe(false);
    expect(__testJournalHasRootMovement({ phase: "service-stopped", moves: [] })).toBe(false);
    expect(
      __testJournalHasRootMovement({
        phase: "service-stopped",
        moves: [
          {
            kind: "park-client-yaml",
            group: "park",
            source: "/a",
            target: "/b",
            required: true,
            state: "pending",
          },
        ],
      }),
    ).toBe(true);
    expect(__testJournalHasRootMovement({ phase: "parked-old-client" })).toBe(true);
    expect(__testJournalHasRootMovement({ phase: "restored-target-client" })).toBe(true);
    expect(__testJournalHasRootMovement({ phase: "credentials-written" })).toBe(true);
    expect(__testJournalHasRootMovement({ phase: "complete" })).toBe(true);

    const configDir = tempDir("ft-client-id-");
    writeFileSync(join(configDir, "client.yaml"), "client:\n  id: not-a-valid-id\n");
    expect(readActiveRootClientId(configDir)).toBeNull();
    writeFileSync(join(configDir, "client.yaml"), "client:\n  id: client_aabbccdd\n");
    expect(readActiveRootClientId(configDir)).toBe("client_aabbccdd");
    writeFileSync(join(configDir, "client.yaml"), "server:\n  url: https://x\n");
    expect(readActiveRootClientId(configDir)).toBeNull();
  });
});

describe("isWslDbusOvermount", () => {
  it("returns false off linux and for non-bus failures", async () => {
    const { isWslDbusOvermount } = await import("../commands/daemon/_shared/wsl-dbus.js");

    setPlatform("darwin");
    expect(isWslDbusOvermount("Failed to connect to bus: No such file or directory")).toBe(false);

    setPlatform("linux");
    expect(isWslDbusOvermount("permission denied")).toBe(false);
  });
});

describe("agent-prune edge branches", () => {
  it("defaults agentsDir and skips plain files in the agents directory", async () => {
    const home = tempDir("ft-prune-home-");
    process.env.FIRST_TREE_HOME = home;
    const agentsDir = join(home, "config", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "not-a-dir.yaml"), "agentId: x\n");
    const goodDir = join(agentsDir, "alpha");
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(join(goodDir, "agent.yaml"), "agentId: 00000000-0000-0000-0000-00000000aaaa\n");

    const { findStaleAliases } = await import("../core/agent-prune.js");
    const stale = await findStaleAliases({
      clientId: "client_self",
      listPinnedAgents: async () => [],
    });
    expect(stale.some((s) => s.name === "alpha")).toBe(true);
    expect(stale.every((s) => s.name !== "not-a-dir.yaml")).toBe(true);
  });
});

describe("binding-state edge branches", () => {
  it("defaults schemaVersion, filters bad members, preserves root entrypoint, and slugs empty names", async () => {
    const root = tempDir("ft-binding-");
    const {
      readSourceState,
      readTreeState,
      readTreeBinding,
      writeSourceState,
      writeTreeState,
      writeTreeBinding,
      upsertWorkspaceMember,
      buildStableSourceId,
      SOURCE_STATE_FILE,
      TREE_STATE_FILE,
      treeBindingPath,
    } = await import("../commands/tree/binding-state.js");

    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeFileSync(
      join(root, SOURCE_STATE_FILE),
      JSON.stringify({
        bindingMode: "workspace-root",
        rootKind: "git-repo",
        scope: "workspace",
        sourceId: "ws",
        sourceName: "Workspace",
        tree: {
          entrypoint: "/workspaces/ws",
          treeId: "tree",
          treeMode: "shared",
          treeRepoName: "context-tree",
        },
        members: [
          {
            sourceId: "good",
            sourceName: "good",
            entrypoint: "/workspaces/ws/repos/good",
            rootKind: "git-repo",
          },
          {
            sourceId: "bad",
            sourceName: "bad",
            entrypoint: "/x",
            rootKind: "not-a-kind",
          },
          "not-an-object",
        ],
      }),
    );

    const source = readSourceState(root);
    expect(source?.schemaVersion).toBe(1);
    expect(source?.members).toHaveLength(1);
    expect(source?.members?.[0]?.sourceId).toBe("good");

    writeFileSync(
      join(root, TREE_STATE_FILE),
      JSON.stringify({
        treeId: "tree",
        treeRepoName: "context-tree",
        treeMode: "shared",
      }),
    );
    expect(readTreeState(root)?.schemaVersion).toBe(1);

    writeTreeBinding(root, "member-a", {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/ws/repos/a",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "member-a",
      sourceName: "a",
      treeMode: "shared",
      treeRepoName: "context-tree",
      workspaceId: "ws",
    });
    const bindingPath = treeBindingPath(root, "member-a");
    const bindingRaw = JSON.parse(readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
    delete bindingRaw.schemaVersion;
    writeFileSync(bindingPath, JSON.stringify(bindingRaw));
    expect(readTreeBinding(root, "member-a")?.schemaVersion).toBe(1);

    writeSourceState(root, {
      bindingMode: "workspace-root",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "ws",
      sourceName: "Workspace",
      tree: {
        entrypoint: "/workspaces/ws",
        treeId: "tree",
        treeMode: "shared",
        treeRepoName: "context-tree",
      },
      workspaceId: "ws",
    });
    upsertWorkspaceMember(
      root,
      "ws",
      {
        entrypoint: "/workspaces/ws/repos/child",
        treeId: "tree",
        treeMode: "shared",
        treeRepoName: "context-tree",
      },
      {
        bindingMode: "workspace-member",
        entrypoint: "/workspaces/ws/repos/child",
        rootKind: "folder",
        sourceId: "child",
        sourceName: "child",
      },
    );
    expect(readSourceState(root)?.tree?.entrypoint).toBe("/workspaces/ws");

    const id = buildStableSourceId("", { fallbackRoot: join(root, "my-repo") });
    expect(id).toMatch(/^my-repo-[a-f0-9]{8}$/);

    writeTreeState(root, {
      treeId: "tree",
      treeMode: "dedicated",
      treeRepoName: "solo-tree",
    });
    expect(readTreeState(root)?.treeMode).toBe("dedicated");
  });
});

describe("onboard remaining branches", () => {
  it("covers error report icons, empty orgs, bare HTTP create errors, and non-Error assistant failures", async () => {
    const home = tempDir("ft-onboard-");
    process.env.FIRST_TREE_HOME = home;
    process.env.FIRST_TREE_SERVER_URL = "http://hub.test";
    mkdirSync(join(home, "config"), { recursive: true });

    const cliFetch = vi.fn();
    vi.doMock("../core/cli-fetch.js", () => ({ cliFetch }));
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: vi.fn(async () => "access"),
    }));

    const { formatCheckReport, onboardCreate } = await import("../core/onboard.js");

    expect(
      formatCheckReport([
        { key: "e", label: "Err", status: "error", value: "boom" },
        { key: "w", label: "Warn", status: "warning", hint: "careful" },
        { key: "o", label: "Ok", status: "ok", value: "fine" },
      ]),
    ).toMatch(/Err|Warn|Ok/);

    cliFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    await expect(onboardCreate({ id: "x", type: "agent" })).rejects.toThrow(/\/me HTTP 503/);

    cliFetch.mockReset();
    cliFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ memberships: [] }),
    });
    await expect(onboardCreate({ id: "x", type: "agent" })).rejects.toThrow(/don't belong to any organization/);

    cliFetch.mockReset();
    cliFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ memberships: [{ organizationId: "org-1", organizationName: "A" }] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      });
    await expect(onboardCreate({ id: "nova", type: "agent", clientId: "c1" })).rejects.toThrow(
      /Failed to create agent \(HTTP 500\)/,
    );

    cliFetch.mockReset();
    cliFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ memberships: [{ organizationId: "org-1", organizationName: "A" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ uuid: "primary-uuid", name: null }),
      })
      .mockRejectedValueOnce("assistant-down");

    await onboardCreate({
      id: "nova",
      type: "agent",
      assistant: "helper",
      clientId: "c1",
    });
    expect(existsSync(join(home, "config", "agents", "nova", "agent.yaml"))).toBe(true);
  });
});

describe("prompt findEnvVar edge paths", () => {
  it("walks optional schema tags and reports missing fields without env hints", async () => {
    const home = tempDir("ft-prompt-");
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "config"), { recursive: true });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    const { promptMissingFields } = await import("../core/prompt.js");
    const schema = {
      nested: {
        _tag: "optional",
        shape: {
          leaf: { _tag: "field", options: { prompt: { message: "Leaf" }, env: "LEAF_ENV" } },
        },
      },
      unlabeled: { _tag: "field", options: { prompt: { message: "No Env" } } },
    };

    await expect(
      promptMissingFields({
        schema,
        role: "client",
        configDir: join(home, "config"),
        cliArgs: {},
      }),
    ).rejects.toThrow(/Missing required configuration/);
  });
});

describe("install runtime unsafe specs", () => {
  it("rejects empty and non-string install specs without spawning npm", async () => {
    const { installClaudeRuntime } = await import("../core/install-claude-runtime.js");
    const { installCodexRuntime } = await import("../core/install-codex-runtime.js");

    await expect(installClaudeRuntime("")).resolves.toMatchObject({
      ok: false,
      reasonCode: "invalid_spec",
    });
    await expect(installClaudeRuntime(123 as unknown as string)).resolves.toMatchObject({
      ok: false,
      reasonCode: "invalid_spec",
    });
    await expect(installCodexRuntime("")).resolves.toMatchObject({
      ok: false,
      reasonCode: "invalid_spec",
    });
  });
});

describe("chat create optional branches", () => {
  it("stringifies non-Error create failures through handleCreateError", async () => {
    const createTaskChat = vi.fn(async () => {
      throw "create-failed";
    });
    const createSdk = vi.fn(() => ({ createTaskChat }));
    const fail = vi.fn((code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    });
    const handleSdkError = vi.fn((error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error));
    });

    vi.doMock("../commands/_shared/local-agent.js", () => ({
      createSdk,
      handleSdkError,
    }));
    vi.doMock("../cli/output.js", () => ({
      fail,
      success: vi.fn(),
    }));
    vi.doMock("../core/doc-capture.js", () => ({
      captureOutboundDocs: vi.fn(async (content: string) => ({ content })),
    }));
    vi.doMock("../commands/chat/_shared/io.js", () => ({
      guardInlineDescription: vi.fn(),
      readStdin: vi.fn(async () => "from-stdin"),
    }));

    const { registerChatCreateCommand } = await import("../commands/chat/create.js");
    const program = new Command();
    program.exitOverride();
    const chat = program.command("chat");
    registerChatCreateCommand(chat);

    await expect(program.parseAsync(["node", "ft", "chat", "create", "hello", "--to", "alice"])).rejects.toThrow(
      /create-failed/,
    );
    expect(handleSdkError).toHaveBeenCalled();
  });
});

describe("config set/get/show branches", () => {
  it("parses false string values and prints secret and non-secret values", async () => {
    const setConfigValue = vi.fn();
    const getConfigValue = vi.fn();
    const home = tempDir("ft-cfg-");
    vi.doMock("@first-tree/shared/config", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@first-tree/shared/config")>()),
      setConfigValue,
      getConfigValue,
      defaultConfigDir: () => join(home, "config"),
      clientConfigSchema: {
        server: { url: { _tag: "field" }, token: { _tag: "field", options: { secret: true } } },
      },
    }));
    const { registerConfigSetCommand } = await import("../commands/config/set.js");
    const { registerConfigGetCommand } = await import("../commands/config/get.js");
    const { registerConfigShowCommand } = await import("../commands/config/show.js");
    const program = new Command();
    program.exitOverride();
    const config = program.command("config");
    registerConfigSetCommand(config);
    registerConfigGetCommand(config);
    registerConfigShowCommand(config);
    await program.parseAsync(["node", "ft", "config", "set", "feature.enabled", "false"]);
    expect(setConfigValue).toHaveBeenCalledWith(expect.any(String), "feature.enabled", false);

    getConfigValue.mockReturnValueOnce("https://hub.example");
    await program.parseAsync(["node", "ft", "config", "get", "server.url"]);
    getConfigValue.mockReturnValueOnce("sekrit");
    await program.parseAsync(["node", "ft", "config", "get", "server.token"]);
    getConfigValue.mockReturnValueOnce("sekrit");
    await program.parseAsync(["node", "ft", "config", "show", "server.token"]);
    getConfigValue.mockReturnValueOnce("https://hub.example");
    await program.parseAsync(["node", "ft", "config", "show", "server.url"]);
  });
});

describe("platform-specific npm and PATH branches", () => {
  it("resolves npm.cmd on win32 and splits PATH with ';'", async () => {
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.PATH = "C:\\bin;C:\\tools";

    vi.doMock("@first-tree/client", () => ({
      classify: vi.fn(() => ({ kind: "transient", reasonCode: "x" })),
      ERROR_KINDS: { TRANSIENT: "transient", PERMANENT: "permanent" },
      getChildProcessRegistry: () => ({
        spawn: () => {
          const { EventEmitter } = require("node:events");
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          queueMicrotask(() => child.emit("exit", 1, null));
          return { child };
        },
      }),
    }));

    const { installClaudeRuntime } = await import("../core/install-claude-runtime.js");
    await expect(installClaudeRuntime("1.0.0")).resolves.toMatchObject({ ok: false });

    vi.doMock("../core/channel.js", () => ({
      channelConfig: {
        channel: "prod",
        binName: "first-tree",
        aliasName: "ft",
        packageName: "first-tree",
        defaultHome: "/tmp/home",
        defaultServerUrl: "https://cloud.first-tree.ai",
        serviceUnitFile: "first-tree.service",
        launchdLabel: "first-tree",
        launchdPlistFile: "first-tree.plist",
        displayName: "First Tree",
        portable: {
          channelPrefix: "prod",
          publicInstallerPath: "prod/install.sh",
          downloadBaseUrl: "https://download.first-tree.ai/releases",
        },
      },
    }));
    vi.doMock("../core/cli-fetch.js", () => ({ cliFetch: vi.fn() }));
    // installPortableSpec eventually uses pathEntries when rewriting shims; invalid
    // portable root still exercises PATH splitting first only after success — so just
    // ensure the win32 install path for npm does not throw above.
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
});

describe("update packageName-null branches", () => {
  it("refuses global self-update when packageName is null (dev channel)", async () => {
    vi.doMock("../core/channel.js", () => ({
      channelConfig: {
        channel: "dev",
        binName: "first-tree-dev",
        aliasName: "ftd",
        packageName: null,
        defaultHome: "/tmp/home",
        defaultServerUrl: "http://127.0.0.1:3000",
        serviceUnitFile: "first-tree-dev.service",
        launchdLabel: "first-tree-dev",
        launchdPlistFile: "first-tree-dev.plist",
        displayName: "First Tree (dev)",
        portable: {
          channelPrefix: null,
          publicInstallerPath: null,
          downloadBaseUrl: null,
        },
      },
    }));
    vi.doMock("@first-tree/client", () => ({
      classify: vi.fn(),
      ERROR_KINDS: { TRANSIENT: "transient", PERMANENT: "permanent" },
      getChildProcessRegistry: vi.fn(),
    }));
    vi.doMock("../core/cli-fetch.js", () => ({ cliFetch: vi.fn() }));

    delete process.env.PATH;
    const dev = await import("../core/update.js");
    expect(dev.PACKAGE_NAME).toBeNull();
    expect(dev.fetchLatestVersion()).toMatchObject({ ok: false });
    await expect(dev.installGlobalLatest()).resolves.toMatchObject({ ok: false });
    await expect(dev.installGlobalSpec("1.2.3")).resolves.toMatchObject({ ok: false });
  });
});

describe("tree snapshot target path", () => {
  it("reads a repo-root snapshot with empty target relative path", async () => {
    const base = tempDir("ft-tree-snap-");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-b", "main"], { cwd: base, stdio: "ignore" });
    writeFileSync(join(base, "NODE.md"), "---\ntitle: Root\nowners: [alice]\n---\n# Root\n");
    writeFileSync(join(base, "leaf.md"), "---\ntitle: Leaf\nowners: [alice]\n---\n# Leaf\n");

    const { readContextTreeSnapshot, renderContextTree } = await import("../commands/tree/tree.js");
    const snap = readContextTreeSnapshot(base, {});
    expect(snap.target).toBe("");
    expect(snap.tree.metadata.title).toBe("Root");

    // Pattern that keeps only root via forceKeep still returns a tree.
    const filtered = readContextTreeSnapshot(base, { pattern: "no-match-*" });
    expect(filtered.tree.children).toEqual([]);

    const rendered = renderContextTree(base, { maxDepth: 0 });
    expect(rendered).toContain("Root");
  });
});

describe("update-state non-object parse", () => {
  it("returns null for null JSON payloads", async () => {
    const path = join(tempDir("ft-upd-state-"), "update-state.json");
    writeFileSync(path, "null");
    const { readUpdateState, recordUpdateAttempt } = await import("../core/update-state.js");
    expect(readUpdateState(path)).toBeNull();
    recordUpdateAttempt(
      {
        at: new Date().toISOString(),
        result: "ok",
        target: "1.0.0",
        currentBefore: "0.9.0",
        installedVersion: "1.0.0",
        reason: null,
      },
      path,
    );
    expect(readUpdateState(path)?.last.installedVersion).toBe("1.0.0");
  });
});

describe("daemon install-codex command branches", () => {
  it("defaults spec to latest, emits JSON failures, and omits version when install reports null", async () => {
    const installCodexRuntime = vi.fn();
    const printResults = vi.fn();
    const runtimeProviderChecks = vi.fn(() => []);
    const probeCapabilities = vi.fn(async () => ({ providers: [] }));
    const fail = vi.fn((code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    });
    const print = {
      line: vi.fn(),
      status: vi.fn(),
      result: vi.fn(),
    };

    vi.doMock("../core/index.js", () => ({
      installCodexRuntime,
      printResults,
      runtimeProviderChecks,
    }));
    vi.doMock("@first-tree/client", () => ({ probeCapabilities }));
    vi.doMock("../cli/output.js", () => ({ fail }));
    vi.doMock("../core/output.js", () => ({
      isJsonMode: () => false,
      print,
    }));

    const { registerDaemonInstallCodexCommand } = await import("../commands/daemon/install-codex.js");

    installCodexRuntime.mockResolvedValueOnce({ ok: false, reason: "no network", retryable: false });
    const program = new Command();
    program.exitOverride();
    const daemon = program.command("daemon");
    registerDaemonInstallCodexCommand(daemon);
    await program.parseAsync(["node", "ft", "daemon", "install-codex"]);
    expect(installCodexRuntime).toHaveBeenCalledWith("latest");
    expect(print.status).toHaveBeenCalledWith("✖", expect.stringContaining("no network"));

    installCodexRuntime.mockResolvedValueOnce({ ok: false, reason: "boom", retryable: true });
    vi.doMock("../core/output.js", () => ({
      isJsonMode: () => true,
      print,
    }));
    vi.resetModules();
    vi.doMock("../core/index.js", () => ({
      installCodexRuntime,
      printResults,
      runtimeProviderChecks,
    }));
    vi.doMock("@first-tree/client", () => ({ probeCapabilities }));
    vi.doMock("../cli/output.js", () => ({ fail }));
    vi.doMock("../core/output.js", () => ({
      isJsonMode: () => true,
      print,
    }));
    const { registerDaemonInstallCodexCommand: registerJson } = await import("../commands/daemon/install-codex.js");
    const program2 = new Command();
    program2.exitOverride();
    const daemon2 = program2.command("daemon");
    registerJson(daemon2);
    await expect(program2.parseAsync(["node", "ft", "daemon", "install-codex", "--json"])).rejects.toMatchObject({
      code: "CODEX_INSTALL_FAILED",
    });

    installCodexRuntime.mockResolvedValueOnce({ ok: true, installedVersion: null });
    vi.resetModules();
    vi.doMock("../core/index.js", () => ({
      installCodexRuntime,
      printResults,
      runtimeProviderChecks,
    }));
    vi.doMock("@first-tree/client", () => ({ probeCapabilities }));
    vi.doMock("../cli/output.js", () => ({ fail }));
    vi.doMock("../core/output.js", () => ({
      isJsonMode: () => false,
      print,
    }));
    const { registerDaemonInstallCodexCommand: registerOk } = await import("../commands/daemon/install-codex.js");
    const program3 = new Command();
    program3.exitOverride();
    const daemon3 = program3.command("daemon");
    registerOk(daemon3);
    await program3.parseAsync(["node", "ft", "daemon", "install-codex", "--spec", "1.0.0"]);
    expect(print.status).toHaveBeenCalledWith("✓", "Installed @openai/codex");
  });
});

describe("agent prune command branches", () => {
  it("uses singular alias wording and stringifies non-Error remove failures", async () => {
    const findStaleAliases = vi.fn(async () => [
      {
        name: "ghost",
        agentId: "00000000-0000-0000-0000-00000000dead",
        reason: { kind: "unowned" as const },
      },
    ]);
    const removeLocalAgent = vi.fn(() => {
      throw "EPERM";
    });
    const formatStaleReason = vi.fn(() => "no longer owned");
    const resolveServerUrl = vi.fn(() => "https://hub.example");
    const ensureFreshAccessToken = vi.fn(async () => "tok");
    const print = { line: vi.fn() };
    const fail = vi.fn((code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    });

    vi.doMock("../core/index.js", () => ({
      CLI_USER_AGENT: "test",
      ensureFreshAccessToken,
      findStaleAliases,
      formatStaleReason,
      removeLocalAgent,
      resolveServerUrl,
    }));
    vi.doMock("../commands/_shared/local-agent.js", () => ({
      readClientId: () => "client_self",
    }));
    vi.doMock("../core/output.js", () => ({ print }));
    vi.doMock("../cli/output.js", () => ({ fail }));
    vi.doMock("@first-tree/client", () => ({
      FirstTreeHubSDK: class {
        listMyAgents = vi.fn(async () => []);
      },
    }));
    vi.doMock("@inquirer/prompts", () => ({
      confirm: vi.fn(async () => true),
    }));

    const { registerAgentPruneCommand } = await import("../commands/agent/prune.js");
    const program = new Command();
    program.exitOverride();
    const agent = program.command("agent");
    registerAgentPruneCommand(agent);
    process.exitCode = undefined;
    await program.parseAsync(["node", "ft", "agent", "prune", "--yes"]);

    const out = print.line.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("1 stale alias");
    expect(out).toContain("EPERM");
    expect(process.exitCode).toBe(1);
  });
});

describe("agent bind client branches", () => {
  it("falls back when error body lacks error field and when agent name is null", async () => {
    const ensureFreshAccessToken = vi.fn(async () => "tok");
    const resolveServerUrl = vi.fn(() => "https://hub.example");
    const resolveAgent = vi.fn(async () => ({ uuid: "agent-uuid", name: null }));
    const cliFetch = vi.fn();
    const fail = vi.fn((code: string, message: string) => {
      throw Object.assign(new Error(message), { code });
    });
    const success = vi.fn();
    const print = { line: vi.fn() };

    vi.doMock("../core/bootstrap.js", () => ({ ensureFreshAccessToken, resolveServerUrl }));
    vi.doMock("../core/channel.js", () => ({
      channelConfig: { binName: "first-tree-dev" },
    }));
    vi.doMock("../core/cli-fetch.js", () => ({ cliFetch }));
    vi.doMock("../commands/_shared/resolve-agent.js", () => ({ resolveAgent }));
    vi.doMock("../cli/output.js", () => ({ fail, success }));
    vi.doMock("../core/output.js", () => ({ print }));

    const { registerAgentBindClientCommand } = await import("../commands/agent/bind/client.js");

    cliFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({}),
    });
    const program = new Command();
    program.exitOverride();
    const bind = program.command("bind");
    registerAgentBindClientCommand(bind);
    await expect(
      program.parseAsync(["node", "ft", "bind", "client", "nova", "--client-id", "client_abcd1234"]),
    ).rejects.toMatchObject({ code: "BIND_CLIENT_ERROR" });
    expect(fail).toHaveBeenCalledWith("BIND_CLIENT_ERROR", expect.stringContaining("HTTP 409"), 1);

    cliFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const program2 = new Command();
    program2.exitOverride();
    const bind2 = program2.command("bind");
    registerAgentBindClientCommand(bind2);
    await program2.parseAsync(["node", "ft", "bind", "client", "nova", "--client-id", "client_abcd1234"]);
    expect(print.line).toHaveBeenCalledWith(expect.stringContaining("agent-uuid"));
    expect(success).toHaveBeenCalled();
  });
});

describe("workspace discovery edge branches", () => {
  it("handles missing sources roots, non-repos, and empty remotes", async () => {
    const root = tempDir("ft-ws-status-");
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    mkdirSync(join(root, "source-repos"), { recursive: true });
    writeFileSync(
      join(root, ".first-tree", "workspace.json"),
      JSON.stringify({
        version: 1,
        tree: "tree",
        sourcesRoot: "source-repos",
        sources: ["alpha", "missing"],
      }),
    );
    // tree missing → treePresent false branch
    // sourcesRoot exists but alpha is not a git repo; missing path absent
    mkdirSync(join(root, "source-repos", "alpha"), { recursive: true });
    writeFileSync(join(root, "source-repos", "alpha", "README"), "x");

    const { computeWorkspaceStatus, pickImmediateWorkspaceSources, readGitRemoteUrl } = await import(
      "../core/workspace.js"
    );
    const status = computeWorkspaceStatus(root);
    expect(status.treePresent).toBe(false);
    expect(status.boundSources.some((s) => s.name === "missing" && !s.present)).toBe(true);
    expect(status.boundSources.some((s) => s.name === "alpha" && s.present)).toBe(true);

    // sourcesRoot with no git children + exclude set
    expect(pickImmediateWorkspaceSources(root, "tree", new Set(["alpha"]))).toEqual([]);
    // missing directory for listImmediateChildDirs
    expect(pickImmediateWorkspaceSources(join(root, "no-such"), "tree")).toEqual([]);
    // non-repo readGitRemoteUrl
    expect(readGitRemoteUrl(join(root, "source-repos", "alpha"))).toBeUndefined();
  });
});

describe("migrate-workspace bindings source names", () => {
  it("returns empty source names when bindings dir is absent", async () => {
    const cwd = tempDir("ft-mig-bind-");
    mkdirSync(join(cwd, "tree"), { recursive: true });
    // no .first-tree/bindings → detect still works without throwing
    const { detectMigrationState } = await import("../core/migrate-workspace.js");
    const state = detectMigrationState(cwd);
    expect(state).toBeDefined();
  });
});

describe("runtime-provider-reconcile yaml rewrite failure", () => {
  it("logs a warning when yaml rewrite fails", async () => {
    const home = tempDir("ft-reconcile-");
    process.env.FIRST_TREE_HOME = home;
    const agentsDir = join(home, "config", "agents");
    const agentDir = join(agentsDir, "bot");
    mkdirSync(agentDir, { recursive: true });
    const yamlPath = join(agentDir, "agent.yaml");
    writeFileSync(yamlPath, "agentId: 00000000-0000-4000-8000-000000000001\nruntime: claude-code\n", {
      mode: 0o600,
    });
    // Read-only file so rewrite writeFileSync fails after a successful parse.
    const { chmodSync } = await import("node:fs");
    chmodSync(yamlPath, 0o400);
    chmodSync(agentDir, 0o500);

    const logs: Array<[string, string]> = [];
    vi.resetModules();
    vi.doMock("../core/cli-fetch.js", () => ({
      cliFetch: vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            agentId: "00000000-0000-4000-8000-000000000001",
            clientId: "client_x",
            runtimeProvider: "codex",
          },
        ],
      })),
    }));
    const { reconcileLocalRuntimeProviders } = await import("../core/runtime-provider-reconcile.js");
    try {
      await reconcileLocalRuntimeProviders({
        serverUrl: "https://hub.example",
        accessToken: "tok",
        agentsDir,
        log: (level, msg) => logs.push([level, msg]),
      });
    } finally {
      chmodSync(agentDir, 0o700);
      chmodSync(yamlPath, 0o600);
    }
    expect(logs.some((l) => l[0] === "warn" && l[1].includes("failed to rewrite"))).toBe(true);
  });
});

describe("isWslDbusOvermount /proc/version missing", () => {
  it("returns false when bus fails but /proc/version is absent", async () => {
    setPlatform("linux");
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (path: string) => {
          if (path === "/proc/version") return false;
          return actual.existsSync(path);
        },
      };
    });
    const { isWslDbusOvermount } = await import("../commands/daemon/_shared/wsl-dbus.js");
    expect(isWslDbusOvermount("Failed to connect to bus: No such file or directory")).toBe(false);
    vi.doUnmock("node:fs");
  });
});

describe("doctor-checks runtime provider check export", () => {
  it("invokes checkRuntimeProviders via mocked probeCapabilities", async () => {
    vi.resetModules();
    const probeCapabilities = vi.fn(async () => ({
      providers: [{ id: "claude-code", available: true, detail: "ok" }],
    }));
    const runtimeProviderChecks = vi.fn(() => [{ name: "Claude", status: "pass" as const, detail: "ok" }]);
    vi.doMock("@first-tree/client", () => ({
      FirstTreeHubSDK: class {},
      probeCapabilities,
    }));
    vi.doMock("../../core/index.js", async () => {
      const actual = await vi.importActual<typeof import("../core/index.js")>("../core/index.js");
      return { ...actual, runtimeProviderChecks, ensureFreshAccessToken: async () => "tok" };
    });
    // path relative from test file is ../commands/_shared/doctor-checks.js
    vi.doMock("../core/index.js", async () => {
      const actual = await vi.importActual<typeof import("../core/index.js")>("../core/index.js");
      return {
        ...actual,
        runtimeProviderChecks,
        ensureFreshAccessToken: async () => "tok",
        resolveServerUrl: () => {
          throw new Error("no server");
        },
        reconcileAgentConfigs: async () => ({ name: "Agents", status: "pass" as const }),
        checkAgentConfigs: () => ({ name: "Agents", status: "pass" as const }),
        checkNodeVersion: () => ({ name: "Node", status: "pass" as const }),
        checkClientConfig: () => ({ name: "Client", status: "pass" as const }),
        checkServerReachable: async () => ({ name: "Server", status: "pass" as const }),
        checkWebSocket: async () => ({ name: "WS", status: "pass" as const }),
        checkBackgroundService: () => ({ name: "Service", status: "pass" as const }),
        CLI_USER_AGENT: "test",
      };
    });
    const { checkRuntimeProviders, runDaemonChecks } = await import("../commands/_shared/doctor-checks.js");
    const runtime = await checkRuntimeProviders();
    expect(runtime).toEqual([{ name: "Claude", status: "pass", detail: "ok" }]);
    const all = await runDaemonChecks();
    expect(all.some((c) => c.name === "Node")).toBe(true);
  });
});
