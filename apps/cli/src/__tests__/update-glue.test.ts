import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelConfig } from "../core/channel.js";

const updateMocks = vi.hoisted(() => ({
  detectInstallMode: vi.fn(),
  installGlobalSpec: vi.fn(),
  PACKAGE_NAME: "first-tree",
}));

const updateStateMocks = vi.hoisted(() => ({
  isLoopGuarded: vi.fn(),
  recordUpdateAttempt: vi.fn(),
}));

const spawnSyncMock = vi.hoisted(() => vi.fn());
const printLineMock = vi.hoisted(() => vi.fn());
const exitMock = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
  throw Object.assign(new Error(`process.exit ${code}`), { exitCode: code });
});

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("../core/update.js", () => updateMocks);
vi.mock("../core/update-state.js", () => updateStateMocks);
vi.mock("../core/output.js", () => ({
  print: { line: printLineMock },
}));

function output(): string {
  return printLineMock.mock.calls.map((call) => String(call[0])).join("");
}

describe("update glue", () => {
  beforeEach(() => {
    updateMocks.detectInstallMode.mockReset();
    updateMocks.installGlobalSpec.mockReset();
    updateStateMocks.isLoopGuarded.mockReset();
    updateStateMocks.recordUpdateAttempt.mockReset();
    spawnSyncMock.mockReset();
    printLineMock.mockClear();
    exitMock.mockClear();

    updateMocks.detectInstallMode.mockReturnValue("global");
    updateMocks.installGlobalSpec.mockResolvedValue({
      ok: true,
      mode: "global",
      installedVersion: "0.6.0",
    });
    updateStateMocks.isLoopGuarded.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 0, signal: null });
  });

  it("declines prompts and skips unsupported install modes", async () => {
    const { createExecuteUpdate, declineUpdate, promptUpdate } = await import("../core/update-glue.js");

    await expect(declineUpdate({ currentVersion: "0.5.0", targetVersion: "0.6.0", timeoutSeconds: 1 })).resolves.toBe(
      false,
    );
    await expect(promptUpdate({ currentVersion: "0.5.0", targetVersion: "0.6.0", timeoutSeconds: 0 })).resolves.toBe(
      false,
    );

    updateMocks.detectInstallMode.mockReturnValueOnce("source");
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: false });
    expect(output()).toContain("Running from source checkout");

    printLineMock.mockClear();
    updateMocks.detectInstallMode.mockReturnValueOnce("npx");
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: false });
    expect(output()).toContain("Cannot self-update");
  });

  it("refuses loop-guarded targets and records install failures", async () => {
    const { createExecuteUpdate } = await import("../core/update-glue.js");
    updateStateMocks.isLoopGuarded.mockReturnValueOnce(true);

    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(updateMocks.installGlobalSpec).not.toHaveBeenCalled();
    expect(output()).toContain("Refusing to retry 0.6.0");

    const onUpdateFailed = vi.fn();
    updateMocks.installGlobalSpec.mockResolvedValueOnce({
      ok: false,
      mode: "global",
      reason: "network down",
      retryable: true,
      reasonCode: "network",
    });

    await expect(
      createExecuteUpdate({ managed: false, onUpdateFailed })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: false });
    expect(updateStateMocks.recordUpdateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ result: "failed", reason: "network down", target: "0.6.0" }),
    );
    expect(onUpdateFailed).toHaveBeenCalledWith({
      targetVersion: "0.6.0",
      retryable: true,
      reasonCode: "network",
    });
  });

  it("blocks stale installs and returns manual restart hints for foreground clients", async () => {
    const { createExecuteUpdate } = await import("../core/update-glue.js");
    updateMocks.installGlobalSpec.mockResolvedValueOnce({
      ok: true,
      mode: "global",
      installedVersion: "0.5.5",
    });

    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(updateStateMocks.recordUpdateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ result: "blocked", installedVersion: "0.5.5" }),
    );
    expect(output()).toContain("Skipping restart to avoid");

    printLineMock.mockClear();
    updateMocks.installGlobalSpec.mockResolvedValueOnce({
      ok: true,
      mode: "global",
      installedVersion: null,
    });
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(updateStateMocks.recordUpdateAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: "ok", installedVersion: null }),
    );
    expect(output()).toContain("Restart the client manually");
  });

  it("refreshes the service unit and exits with the self-restart code for managed clients", async () => {
    const { SELF_RESTART_EXIT_CODE, createExecuteUpdate } = await import("../core/update-glue.js");

    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).rejects.toMatchObject({ exitCode: SELF_RESTART_EXIT_CODE });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      channelConfig.binName,
      ["daemon", "refresh-unit"],
      expect.objectContaining({ timeout: 45_000 }),
    );
    expect(exitMock).toHaveBeenCalledWith(SELF_RESTART_EXIT_CODE);

    printLineMock.mockClear();
    spawnSyncMock.mockReturnValueOnce({ status: 7, signal: "SIGTERM" });
    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).rejects.toMatchObject({ exitCode: SELF_RESTART_EXIT_CODE });
    expect(output()).toContain("warning: 'daemon refresh-unit' exited with status 7");
  });
});
