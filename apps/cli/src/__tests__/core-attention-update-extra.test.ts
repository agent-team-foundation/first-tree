import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const cliFetchMock = vi.hoisted(() => vi.fn());

const printLineMock = vi.hoisted(() => vi.fn());

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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
  } as unknown as Response;
}

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function installSpawn(child: MockChild): void {
  childRegistryMocks.getChildProcessRegistry.mockReturnValue({
    spawn: vi.fn(() => ({ child })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  childRegistryMocks.classify.mockReturnValue({ kind: "permanent", reasonCode: "classified" });
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "0.6.0\n", stderr: "" });
});

describe("core attention helpers", () => {
  it("passes through SDK attention helpers", async () => {
    const sdk = {
      attention: {
        cancel: vi.fn(async () => ({ id: "attention-1", state: "closed" })),
        list: vi.fn(async () => [{ id: "attention-1" }]),
        raise: vi.fn(async () => ({ id: "attention-2" })),
        show: vi.fn(async () => ({ id: "attention-3" })),
      },
    };
    const { cancelAttention, listAttentions, raiseAttention, showAttention } = await import(
      "../core/attention/index.js"
    );

    await expect(cancelAttention(sdk as never, { id: "attention-1", reason: "obsolete" })).resolves.toEqual({
      id: "attention-1",
      state: "closed",
    });
    expect(sdk.attention.cancel).toHaveBeenCalledWith("attention-1", "obsolete");

    await expect(listAttentions(sdk as never, { state: "open" })).resolves.toEqual([{ id: "attention-1" }]);
    expect(sdk.attention.list).toHaveBeenCalledWith({ state: "open" });

    await expect(
      raiseAttention(sdk as never, {
        chatId: "chat-1",
        target: "human-1",
        subject: "Approve",
        body: "Ship?",
        requiresResponse: true,
        metadata: { priority: 2 },
      }),
    ).resolves.toEqual({ id: "attention-2" });
    expect(sdk.attention.raise).toHaveBeenCalledWith({
      chatId: "chat-1",
      target: "human-1",
      subject: "Approve",
      body: "Ship?",
      requiresResponse: true,
      metadata: { priority: 2 },
    });

    await expect(showAttention(sdk as never, "attention-3")).resolves.toEqual({ id: "attention-3" });
    expect(sdk.attention.show).toHaveBeenCalledWith("attention-3");
  });

  it("responds over member HTTP, parses server errors, and validates response payloads", async () => {
    const validAttention = {
      id: "00000000-0000-7000-8000-000000000001",
      originAgentId: "00000000-0000-7000-8000-000000000002",
      originChatId: "00000000-0000-7000-8000-000000000003",
      targetHumanId: "00000000-0000-7000-8000-000000000004",
      subject: "Approve deploy",
      body: "Can I ship?",
      requiresResponse: true,
      state: "closed",
      response: "approved",
      respondedBy: "00000000-0000-7000-8000-000000000004",
      respondedAt: "2026-06-01T00:00:00.000Z",
      cancelled: false,
      cancelledReason: null,
      metadata: {},
      createdAt: "2026-06-01T00:00:00.000Z",
      closedAt: "2026-06-01T00:00:00.000Z",
    };
    const { AttentionRespondError, respondAttention } = await import("../core/attention/respond.js");

    cliFetchMock.mockResolvedValueOnce(jsonResponse(validAttention));
    await expect(respondAttention({ id: "attention/1", text: "approved" })).resolves.toMatchObject({
      subject: "Approve deploy",
    });
    expect(cliFetchMock).toHaveBeenCalledWith("https://hub.example/api/v1/attention/attention%2F1/respond", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "approved" }),
      signal: expect.any(AbortSignal),
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse(validAttention));
    await respondAttention({ id: "attention-1", answers: { choice: "ship" } });
    expect(cliFetchMock).toHaveBeenLastCalledWith(
      "https://hub.example/api/v1/attention/attention-1/respond",
      expect.objectContaining({ body: JSON.stringify({ answers: { choice: "ship" } }) }),
    );

    cliFetchMock.mockResolvedValueOnce(jsonResponse(JSON.stringify({ error: "already closed" }), false, 409));
    await expect(respondAttention({ id: "attention-1", text: "again" })).rejects.toMatchObject({
      statusCode: 409,
      message: "already closed",
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse("plain failure", false, 500));
    await expect(respondAttention({ id: "attention-1", text: "again" })).rejects.toBeInstanceOf(AttentionRespondError);

    cliFetchMock.mockResolvedValueOnce(jsonResponse({ nope: true }));
    await expect(respondAttention({ id: "attention-1", text: "bad payload" })).rejects.toThrow();
  });
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
    const failPromise = installGlobalSpec("latest");
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
});
