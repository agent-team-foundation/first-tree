import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const classifyMock = vi.fn();
const printLineMock = vi.fn();
const registrySpawnMock = vi.fn();

function makeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

async function loadUpdateWithRegistry() {
  vi.resetModules();
  vi.doMock("@first-tree/client", () => ({
    ERROR_KINDS: {
      PERMANENT: "permanent",
      TRANSIENT: "transient",
    },
    classify: classifyMock,
    getChildProcessRegistry: () => ({ spawn: registrySpawnMock }),
  }));
  vi.doMock("../core/channel.js", () => ({
    channelConfig: {
      channel: "prod",
      packageName: "first-tree",
    },
  }));
  vi.doMock("../core/output.js", () => ({ print: { line: printLineMock } }));
  return import("../core/update.js");
}

describe("update.installGlobalSpec subprocess handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classifyMock.mockReturnValue({ kind: "permanent", reasonCode: "classified" });
  });

  it("spawns npm through the child-process registry and parses installed versions", async () => {
    const child = makeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    const { installGlobalSpec } = await loadUpdateWithRegistry();

    const resultPromise = installGlobalSpec("1.2.3");
    child.stdout.emit("data", Buffer.from("+ first-tree@1.2.3\n"));
    child.emit("exit", 0, null);

    await expect(resultPromise).resolves.toEqual({ ok: true, mode: "global", installedVersion: "1.2.3" });
    expect(registrySpawnMock).toHaveBeenCalledWith(
      expect.stringMatching(/npm(?:\.cmd)?$/),
      ["install", "-g", "first-tree@1.2.3"],
      expect.objectContaining({
        category: "npm-install",
        label: "npm install -g first-tree@1.2.3",
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: 300_000,
      }),
    );
  });

  it("returns null installedVersion when npm stdout does not include the package", async () => {
    const child = makeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    const { installGlobalSpec } = await loadUpdateWithRegistry();

    const resultPromise = installGlobalSpec("latest");
    child.stdout.emit("data", Buffer.from("up to date\n"));
    child.emit("exit", 0, null);

    await expect(resultPromise).resolves.toEqual({ ok: true, mode: "global", installedVersion: null });
  });

  it("classifies registry spawn errors as retryable when transient", async () => {
    const child = makeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    classifyMock.mockReturnValueOnce({ kind: "transient", reasonCode: "network" });
    const { installGlobalSpec } = await loadUpdateWithRegistry();

    const resultPromise = installGlobalSpec("latest");
    child.emit("error", new Error("registry unavailable"));

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      mode: "global",
      reason: "registry unavailable",
      retryable: true,
      reasonCode: "network",
    });
    expect(classifyMock).toHaveBeenCalledWith(expect.any(Error), { source: "update" });
  });

  it("includes stderr tail and classification metadata for non-zero npm exits", async () => {
    const child = makeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    classifyMock.mockReturnValueOnce({ kind: "permanent", reasonCode: "permission" });
    const { installGlobalSpec } = await loadUpdateWithRegistry();

    const resultPromise = installGlobalSpec("latest");
    child.stderr.emit("data", Buffer.from("first line\nsecond line\nthird line\nfourth line\n"));
    child.emit("exit", 1, null);
    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: false,
      mode: "global",
      retryable: false,
      reasonCode: "permission",
    });
    if (!result.ok) {
      expect(result.reason).toContain("npm install -g exited with code 1");
      expect(result.reason).toContain("second line | third line | fourth line");
    }
    expect(printLineMock).toHaveBeenCalledWith("first line\nsecond line\nthird line\nfourth line\n");
  });

  it("treats signal-only exits as retryable timeouts", async () => {
    const child = makeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    const { installGlobalSpec } = await loadUpdateWithRegistry();

    const resultPromise = installGlobalSpec("latest");
    child.emit("exit", null, "SIGTERM");

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      mode: "global",
      reason: "npm install -g killed by signal SIGTERM (timeout)",
      retryable: true,
      reasonCode: "npm_timeout",
    });
    expect(classifyMock).not.toHaveBeenCalled();
  });
});
