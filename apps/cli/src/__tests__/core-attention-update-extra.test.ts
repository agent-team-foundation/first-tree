import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const printLineMock = vi.hoisted(() => vi.fn());
const cliFetchMock = vi.hoisted(() => vi.fn());

const childRegistryMocks = vi.hoisted(() => ({
  classify: vi.fn(),
  ERROR_KINDS: { TRANSIENT: "transient", PERMANENT: "permanent" },
  getChildProcessRegistry: vi.fn(),
}));

const spawnSyncMock = vi.hoisted(() => vi.fn());

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
    spawn: vi.fn(() => ({ child })),
  });
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
    expect(childRegistryMocks.getChildProcessRegistry().spawn).toHaveBeenCalledWith(
      expect.stringMatching(/npm(?:\\.cmd)?$/),
      ["install", "-g", "first-tree@0.6.0"],
      expect.objectContaining({ category: "npm-install", timeoutMs: 300_000 }),
    );

    const child2 = new MockChild();
    installSpawn(child2);
    const latestPromise = installGlobalLatest();
    child2.stdout.emit("data", Buffer.from("updated package\n"));
    child2.emit("exit", 0, null);
    await expect(latestPromise).resolves.toEqual({ ok: true, mode: "global", installedVersion: null });
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

  it("fetches latest versions and handles npm view failures or invalid output", async () => {
    const { fetchLatestVersion } = await import("../core/update.js");

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "0.6.0\n", stderr: "" });
    expect(fetchLatestVersion()).toEqual({ ok: true, version: "0.6.0" });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "registry down\n" });
    expect(fetchLatestVersion()).toEqual({ ok: false, reason: "registry down" });

    spawnSyncMock.mockReturnValueOnce({ status: 7, stdout: "", stderr: "" });
    expect(fetchLatestVersion()).toEqual({ ok: false, reason: "npm view exited with code 7" });

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

    cliFetchMock.mockResolvedValueOnce(jsonResponse({}, false, 503));
    await expect(fetchServerCommandVersion()).resolves.toEqual({ ok: false, reason: "server returned HTTP 503" });
  });
});
