import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNpmInvocation } from "../core/npm-invocation.js";

const bootstrapMocks = vi.hoisted(() => {
  class ServerUrlNotConfiguredError extends Error {
    constructor() {
      super("Server URL not configured.");
      this.name = "ServerUrlNotConfiguredError";
    }
  }
  return {
    ensureFreshAccessToken: vi.fn(),
    resolveServerUrl: vi.fn(),
    ServerUrlNotConfiguredError,
  };
});

const printLineMock = vi.hoisted(() => vi.fn());
const cliFetchMock = vi.hoisted(() => vi.fn());

const childRegistryMocks = vi.hoisted(() => ({
  classify: vi.fn(),
  ERROR_KINDS: { TRANSIENT: "transient", PERMANENT: "permanent" },
  getChildProcessRegistry: vi.fn(),
}));

const spawnSyncMock = vi.hoisted(() => vi.fn());
const registrySpawnMock = vi.hoisted(() => vi.fn());
const originalPlatform = process.platform;
const originalArch = process.arch;

const prodChannelConfig = {
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
};

vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("../core/output.js", () => ({ print: { line: printLineMock } }));
vi.mock("@first-tree/client", () => childRegistryMocks);
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function installSpawn(child: MockChild): void {
  childRegistryMocks.getChildProcessRegistry.mockReturnValue({
    spawn: registrySpawnMock,
  });
  registrySpawnMock.mockImplementationOnce(() => ({ child }));
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
  vi.doMock("../core/channel.js", () => ({ channelConfig: prodChannelConfig }));
  registrySpawnMock.mockReset();
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  Object.defineProperty(process, "arch", { configurable: true, value: originalArch });
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  childRegistryMocks.classify.mockReturnValue({ kind: "permanent", reasonCode: "classified" });
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "0.6.0\n", stderr: "" });
});

describe("core update helpers", () => {
  it("detects malformed package manifests and missing paths during install-mode discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-update-detect-extra-"));
    try {
      const packageDir = join(root, "node_modules", "first-tree");
      mkdirSync(join(packageDir, "dist"), { recursive: true });
      writeFileSync(join(packageDir, "package.json"), "{not-json");
      writeFileSync(join(packageDir, "dist", "index.mjs"), "// stub");

      const { detectInstallMode } = await import("../core/update.js");
      expect(detectInstallMode("", "first-tree")).toBe("npx");
      expect(detectInstallMode(join(packageDir, "dist", "missing.mjs"), "first-tree")).toBe("npx");
      expect(detectInstallMode(join(packageDir, "dist", "index.mjs"), "first-tree")).toBe("npx");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects platform npm commands, including Windows and sibling npm layouts", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
          String(path).replaceAll("\\", "/").endsWith("/node_modules/npm/bin/npm-cli.js") || actual.existsSync(path),
      };
    });
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "0.6.0\n", stderr: "" });
    const winUpdate = await import("../core/update.js");

    expect(winUpdate.fetchLatestVersion()).toEqual({ ok: true, version: "0.6.0" });
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual([
      expect.stringMatching(/[\\/]node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/),
      "view",
      "first-tree",
      "version",
    ]);
    expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ shell: false });

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
          String(path).replaceAll("\\", "/").endsWith("/npm") || actual.existsSync(path),
      };
    });
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "0.7.0\n", stderr: "" });
    const siblingUpdate = await import("../core/update.js");

    expect(siblingUpdate.fetchLatestVersion()).toEqual({ ok: true, version: "0.7.0" });
    expect(String(spawnSyncMock.mock.calls[1]?.[0])).toMatch(/[\\/]npm$/);
    expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ shell: false });
  });

  it("runs npm installs through the child registry and parses installed versions", async () => {
    vi.resetModules();
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
      },
    }));
    const child = new MockChild();
    installSpawn(child);
    const { installGlobalLatest, installGlobalSpec } = await import("../core/update.js");
    const resultPromise = installGlobalSpec("0.6.0");
    child.stdout.emit("data", Buffer.from("+ first-tree@0.6.0,\n"));
    child.emit("exit", 0, null);
    await expect(resultPromise).resolves.toEqual({ ok: true, mode: "global", installedVersion: "0.6.0" });
    const npm = resolveNpmInvocation(["install", "-g", "first-tree@0.6.0"]);
    expect(childRegistryMocks.getChildProcessRegistry().spawn).toHaveBeenCalledWith(
      npm.command,
      npm.args,
      expect.objectContaining({
        category: "npm-install",
        timeoutMs: 300_000,
        shell: npm.shell,
      }),
    );

    const child2 = new MockChild();
    installSpawn(child2);
    const latestPromise = installGlobalLatest();
    child2.stdout.emit("data", Buffer.from("updated package\n"));
    child2.emit("exit", 0, null);
    await expect(latestPromise).resolves.toEqual({ ok: true, mode: "global", installedVersion: null });
  });

  it("preflights npm-mode target engines and points incompatible users at Node or portable install", async () => {
    vi.resetModules();
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
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: JSON.stringify(">=999.0.0"), stderr: "" });
    const child = new MockChild();
    installSpawn(child);

    const { installGlobalSpec } = await import("../core/update.js");
    const output = vi.fn();
    const result = await installGlobalSpec("0.6.0", { output });

    expect(result).toMatchObject({
      ok: false,
      mode: "global",
      retryable: false,
      reasonCode: "npm_ebadengine",
    });
    if (result.ok) throw new Error("expected engine mismatch");
    expect(result.reason).toContain("npm-mode updates cannot replace the system Node runtime");
    expect(result.reason).toContain("https://download.first-tree.ai/releases/prod/install.sh");
    expect(childRegistryMocks.getChildProcessRegistry().spawn).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining("requires Node >=999.0.0"));
  });

  it("allows npm installs when target engine metadata is absent, malformed, invalid, or already satisfied", async () => {
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
      },
    }));
    const { installGlobalSpec } = await import("../core/update.js");

    const cases = [
      { status: 1, stdout: "", stderr: "npm view failed" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "not-json", stderr: "" },
      { status: 0, stdout: JSON.stringify([]), stderr: "" },
      { status: 0, stdout: JSON.stringify({ engines: { node: "not a range" } }), stderr: "" },
      { status: 0, stdout: JSON.stringify({ engines: { node: `>=${process.versions.node}` } }), stderr: "" },
    ];

    for (const [index, metadata] of cases.entries()) {
      spawnSyncMock.mockReturnValueOnce(metadata);
      const child = new MockChild();
      installSpawn(child);
      const installing = installGlobalSpec("latest");
      child.stdout.emit("data", Buffer.from(`+ first-tree@0.9.${index}\n`));
      child.emit("exit", 0, null);
      await expect(installing).resolves.toMatchObject({ ok: true, mode: "global" });
    }

    expect(registrySpawnMock).toHaveBeenCalledTimes(cases.length);
  });

  it("parses nested npm engine metadata and omits installer URLs when portable metadata is not configured", async () => {
    vi.resetModules();
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
          downloadBaseUrl: null,
        },
      },
    }));
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ engines: { node: ">=999.0.0" } }),
      stderr: "",
    });
    const child = new MockChild();
    installSpawn(child);

    const { installGlobalSpec } = await import("../core/update.js");
    const result = await installGlobalSpec("0.6.0");

    expect(result).toMatchObject({
      ok: false,
      mode: "global",
      retryable: false,
      reasonCode: "npm_ebadengine",
    });
    if (result.ok) throw new Error("expected engine mismatch");
    expect(result.reason).toContain("or migrate to the portable install path from the web console.");
    expect(result.reason).not.toContain("installer: https://");
    expect(childRegistryMocks.getChildProcessRegistry().spawn).not.toHaveBeenCalled();
  });

  it("fails closed for dev-channel npm publishing paths", async () => {
    vi.doMock("../core/channel.js", () => ({
      channelConfig: {
        channel: "dev",
        binName: "first-tree-dev",
        aliasName: "ftd",
        packageName: null,
        defaultHome: "/tmp/home",
        defaultServerUrl: "https://cloud.first-tree.ai",
        serviceUnitFile: "first-tree-dev.service",
        launchdLabel: "first-tree-dev",
        launchdPlistFile: "first-tree-dev.plist",
        displayName: "First Tree Dev",
        portable: { channelPrefix: null, publicInstallerPath: null, downloadBaseUrl: null },
      },
    }));
    const { fetchLatestVersion, installGlobalSpec } = await import("../core/update.js");

    expect(await installGlobalSpec("latest")).toMatchObject({
      ok: false,
      mode: "global",
      reason: expect.stringContaining("does not publish to npm"),
    });
    expect(fetchLatestVersion()).toEqual({
      ok: false,
      reason: "this binary's channel does not publish to npm (dev channel).",
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("reports unsupported portable platforms before metadata download", async () => {
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
    const { installPortableSpec } = await import("../core/update.js");

    Object.defineProperty(process, "platform", { configurable: true, value: "freebsd" });
    Object.defineProperty(process, "arch", { configurable: true, value: "x64" });
    await expect(installPortableSpec("1.2.3")).resolves.toMatchObject({
      ok: false,
      reason: "portable self-update is not supported on freebsd-x64",
    });

    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    Object.defineProperty(process, "arch", { configurable: true, value: "ia32" });
    await expect(installPortableSpec("1.2.3")).resolves.toMatchObject({
      ok: false,
      reason: "portable self-update is not supported on linux-ia32",
    });
    expect(cliFetchMock).not.toHaveBeenCalled();
  });

  it("validates portable latest metadata shape and channel before returning a version", async () => {
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
          downloadBaseUrl: "https://download.first-tree.ai/releases/",
        },
      },
    }));
    const { fetchPortableLatestVersion } = await import("../core/update.js");
    const base = {
      schemaVersion: 1,
      channel: "staging",
      version: "1.2.3",
      gitSha: "abc123",
      nodeVersion: "v24.0.0",
      packageName: "first-tree",
      binName: "first-tree",
      aliasName: "ft",
      generatedAt: "2026-01-01T00:00:00.000Z",
      manifestUrl: "https://download.first-tree.ai/releases/prod/1.2.3/manifest.json",
      assets: [
        {
          platform: "linux-x64",
          fileName: "first-tree-linux-x64.tar.gz",
          url: "https://download.first-tree.ai/releases/prod/1.2.3/first-tree-linux-x64.tar.gz",
          sha256: "a".repeat(64),
          size: 1,
        },
      ],
    };
    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn(async () => JSON.stringify(base)),
    } as unknown as Response);

    await expect(fetchPortableLatestVersion()).resolves.toEqual({
      ok: false,
      reason: 'Refusing portable latest metadata: portable metadata channel "staging" does not match my channel "prod"',
    });

    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn(async () => "{not-json"),
    } as unknown as Response);
    await expect(fetchPortableLatestVersion()).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("invalid JSON from"),
    });
  });

  it("classifies child errors, non-zero exits, and timeouts", async () => {
    vi.resetModules();
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
      },
    }));
    const { installGlobalSpec } = await import("../core/update.js");

    childRegistryMocks.classify.mockReturnValueOnce({ kind: "transient", reasonCode: "network" });
    const errorChild = new MockChild();
    installSpawn(errorChild);
    const errorPromise = installGlobalSpec("latest");
    errorChild.emit("error", new Error("spawn failed"));
    await expect(errorPromise).resolves.toMatchObject({
      ok: false,
      reason: "spawn failed",
      retryable: true,
      reasonCode: "network",
    });

    childRegistryMocks.classify.mockReturnValueOnce({ kind: "permanent", reasonCode: "ebadengine" });
    const failChild = new MockChild();
    installSpawn(failChild);
    const installOutput: string[] = [];
    const failPromise = installGlobalSpec("latest", { output: (chunk) => installOutput.push(chunk) });
    failChild.stderr.emit("data", Buffer.from("line1\nline2\nline3\nline4\n"));
    failChild.emit("exit", 1, null);
    const failResult = await failPromise;
    expect(failResult).toMatchObject({
      ok: false,
      retryable: false,
      reasonCode: "ebadengine",
    });
    if (failResult.ok) throw new Error("expected install failure");
    expect(failResult.reason).toContain("line2 | line3 | line4");
    expect(installOutput).toEqual(["line1\nline2\nline3\nline4\n"]);
    expect(printLineMock).not.toHaveBeenCalled();

    const timeoutChild = new MockChild();
    installSpawn(timeoutChild);
    const timeoutPromise = installGlobalSpec("latest");
    timeoutChild.emit("exit", null, "SIGTERM");
    await expect(timeoutPromise).resolves.toMatchObject({
      ok: false,
      retryable: true,
      reasonCode: "npm_timeout",
    });
  });

  it("maps synchronous registry spawn failures instead of rejecting the upgrade", async () => {
    const spawnError = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    childRegistryMocks.classify.mockReturnValueOnce({ kind: "permanent", reasonCode: "spawn_einval" });
    childRegistryMocks.getChildProcessRegistry.mockReturnValue({
      spawn: vi.fn(() => {
        throw spawnError;
      }),
    });
    const { installGlobalSpec } = await import("../core/update.js");

    await expect(installGlobalSpec("latest")).resolves.toEqual({
      ok: false,
      mode: "global",
      reason: "spawn EINVAL",
      retryable: false,
      reasonCode: "spawn_einval",
    });
  });

  it("fetches latest versions and handles npm view failures or invalid output", async () => {
    const { fetchLatestVersion } = await import("../core/update.js");

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "0.6.0\n", stderr: "" });
    expect(fetchLatestVersion()).toEqual({ ok: true, version: "0.6.0" });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "registry down\n" });
    expect(fetchLatestVersion()).toEqual({ ok: false, reason: "registry down" });

    spawnSyncMock.mockReturnValueOnce({ status: 8, stdout: undefined, stderr: undefined });
    expect(fetchLatestVersion()).toEqual({ ok: false, reason: "npm view exited with code 8" });

    spawnSyncMock.mockReturnValueOnce({ status: 7, stdout: "", stderr: "" });
    expect(fetchLatestVersion()).toEqual({ ok: false, reason: "npm view exited with code 7" });

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: undefined, stderr: "" });
    expect(fetchLatestVersion()).toEqual({ ok: false, reason: "npm view returned non-semver value: " });

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "latest\n", stderr: "" });
    expect(fetchLatestVersion()).toEqual({ ok: false, reason: "npm view returned non-semver value: latest" });
  });

  it("fetches the server command version from bootstrap config", async () => {
    const { fetchServerCommandVersion } = await import("../core/update.js");

    cliFetchMock.mockResolvedValueOnce(jsonResponse({ serverCommandVersion: "v0.6.0" }));
    await expect(fetchServerCommandVersion()).resolves.toEqual({ ok: true, version: "0.6.0" });
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example/api/v1/bootstrap/config",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    cliFetchMock.mockResolvedValueOnce(jsonResponse({ serverCommandVersion: "latest" }));
    await expect(fetchServerCommandVersion()).resolves.toEqual({
      ok: false,
      reason: "server returned non-semver version: latest",
    });

    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn(async () => {
        throw "json failed";
      }),
    } as unknown as Response);
    await expect(fetchServerCommandVersion()).resolves.toEqual({
      ok: false,
      reason: "server returned invalid JSON: json failed",
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse({}, false, 503));
    await expect(fetchServerCommandVersion()).resolves.toEqual({ ok: false, reason: "server returned HTTP 503" });

    bootstrapMocks.resolveServerUrl.mockImplementationOnce(() => {
      throw new bootstrapMocks.ServerUrlNotConfiguredError();
    });
    await expect(fetchServerCommandVersion()).resolves.toEqual({
      ok: false,
      reason: "Server URL not configured.",
      reasonCode: "server_url_not_configured",
    });
  });
});
