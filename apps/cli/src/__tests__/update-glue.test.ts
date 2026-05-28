import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirmMock = vi.fn<() => Promise<boolean>>();
const detectInstallModeMock = vi.fn<() => "global" | "npx" | "source">();
const installGlobalSpecMock = vi.fn<(targetVersion: string) => Promise<Record<string, unknown>>>();
const isLoopGuardedMock = vi.fn<(targetVersion: string) => boolean>();
const printLineMock = vi.fn();
const recordUpdateAttemptMock = vi.fn();
const spawnSyncMock = vi.fn();

async function loadUpdateGlue() {
  vi.doMock("@inquirer/prompts", () => ({ confirm: confirmMock }));
  vi.doMock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
  vi.doMock("../core/channel.js", () => ({
    channelConfig: {
      binName: "first-tree-dev",
      packageName: "first-tree",
    },
  }));
  vi.doMock("../core/output.js", () => ({ print: { line: printLineMock } }));
  vi.doMock("../core/update.js", () => ({
    detectInstallMode: detectInstallModeMock,
    installGlobalSpec: installGlobalSpecMock,
    PACKAGE_NAME: "first-tree",
  }));
  vi.doMock("../core/update-state.js", () => ({
    isLoopGuarded: isLoopGuardedMock,
    recordUpdateAttempt: recordUpdateAttemptMock,
  }));
  return import("../core/update-glue.js");
}

describe("update glue", () => {
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    detectInstallModeMock.mockReturnValue("global");
    installGlobalSpecMock.mockResolvedValue({ ok: true, mode: "global", installedVersion: "1.2.3" });
    isLoopGuardedMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 0, signal: null });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("prompts for interactive updates and declines on prompt failure", async () => {
    const { declineUpdate, promptUpdate } = await loadUpdateGlue();

    await expect(promptUpdate({ currentVersion: "1.0.0", targetVersion: "1.1.0", timeoutSeconds: 1 })).resolves.toBe(
      true,
    );
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ default: false, message: expect.stringContaining("Server recommends: 1.1.0") }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    confirmMock.mockRejectedValueOnce(new Error("stdin closed"));
    await expect(promptUpdate({ currentVersion: "1.0.0", targetVersion: "1.1.0", timeoutSeconds: 1 })).resolves.toBe(
      false,
    );
    await expect(declineUpdate({ currentVersion: "1.0.0", targetVersion: "1.1.0", timeoutSeconds: 1 })).resolves.toBe(
      false,
    );
  });

  it("skips update execution for source and npx launch modes", async () => {
    const { createExecuteUpdate } = await loadUpdateGlue();

    detectInstallModeMock.mockReturnValueOnce("source");
    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "1.0.0", targetVersion: "1.1.0" }),
    ).resolves.toEqual({ installed: false });
    expect(printLineMock.mock.calls.flat().join("")).toContain("Running from source checkout");

    detectInstallModeMock.mockReturnValueOnce("npx");
    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "1.0.0", targetVersion: "1.1.0" }),
    ).resolves.toEqual({ installed: false });
    expect(printLineMock.mock.calls.flat().join("")).toContain("Cannot self-update");
    expect(installGlobalSpecMock).not.toHaveBeenCalled();
  });

  it("blocks retry loops before invoking npm", async () => {
    const { createExecuteUpdate } = await loadUpdateGlue();

    isLoopGuardedMock.mockReturnValueOnce(true);
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "1.0.0", targetVersion: "1.1.0" }),
    ).resolves.toEqual({ installed: true });

    expect(printLineMock.mock.calls.flat().join("")).toContain("Refusing to retry 1.1.0");
    expect(recordUpdateAttemptMock).not.toHaveBeenCalled();
    expect(installGlobalSpecMock).not.toHaveBeenCalled();
  });

  it("records failed installs and reports retry metadata without letting the hook throw", async () => {
    const { createExecuteUpdate } = await loadUpdateGlue();
    const onUpdateFailed = vi.fn(() => {
      throw new Error("observer failed");
    });
    installGlobalSpecMock.mockResolvedValueOnce({
      ok: false,
      mode: "global",
      reason: "network unavailable",
      retryable: true,
      reasonCode: "network",
    });

    await expect(
      createExecuteUpdate({ managed: false, onUpdateFailed })({
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
      }),
    ).resolves.toEqual({ installed: false });

    expect(recordUpdateAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "failed",
        target: "1.1.0",
        currentBefore: "1.0.0",
        reason: "network unavailable",
      }),
    );
    expect(onUpdateFailed).toHaveBeenCalledWith({ targetVersion: "1.1.0", retryable: true, reasonCode: "network" });
  });

  it("arms the loop guard when npm installs an older version than the server target", async () => {
    const { createExecuteUpdate } = await loadUpdateGlue();
    installGlobalSpecMock.mockResolvedValueOnce({ ok: true, mode: "global", installedVersion: "1.0.5" });

    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "1.0.0", targetVersion: "1.1.0" }),
    ).resolves.toEqual({ installed: true });

    expect(recordUpdateAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "blocked",
        target: "1.1.0",
        installedVersion: "1.0.5",
      }),
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns a manual restart hint when unmanaged install succeeds", async () => {
    const { createExecuteUpdate } = await loadUpdateGlue();

    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "1.0.0", targetVersion: "1.2.3" }),
    ).resolves.toEqual({ installed: true });

    expect(recordUpdateAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ result: "ok", target: "1.2.3", installedVersion: "1.2.3" }),
    );
    expect(printLineMock.mock.calls.flat().join("")).toContain("Restart the client manually");
  });

  it("refreshes the service unit and exits with the supervisor restart code when managed", async () => {
    const { SELF_RESTART_EXIT_CODE, createExecuteUpdate } = await loadUpdateGlue();

    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "1.0.0", targetVersion: "1.2.3" }),
    ).rejects.toThrow(`exit:${SELF_RESTART_EXIT_CODE}`);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "first-tree-dev",
      ["daemon", "refresh-unit"],
      expect.objectContaining({
        env: expect.objectContaining({ FIRST_TREE_SERVICE_MODE: "" }),
        timeout: 45_000,
      }),
    );
  });

  it("warns when refresh-unit fails or cannot be spawned", async () => {
    const { createExecuteUpdate } = await loadUpdateGlue();

    spawnSyncMock.mockReturnValueOnce({ status: 1, signal: "SIGTERM" });
    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "1.0.0", targetVersion: "1.2.3" }),
    ).rejects.toThrow("exit:75");
    expect(printLineMock.mock.calls.flat().join("")).toContain("exited with status 1");

    printLineMock.mockClear();
    spawnSyncMock.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "1.0.0", targetVersion: "1.2.3" }),
    ).rejects.toThrow("exit:75");
    expect(printLineMock.mock.calls.flat().join("")).toContain("could not spawn");
  });
});
