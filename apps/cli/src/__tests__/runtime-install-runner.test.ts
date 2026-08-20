import type { RuntimeInstallResultFrame, RuntimeInstallStartCommand } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeInstallRunner } from "../core/runtime-install.js";

const CODEX: RuntimeInstallStartCommand = {
  type: "runtime-install:start",
  provider: "codex",
  ref: "123e4567-e89b-42d3-a456-426614174000",
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("runtime install runner", () => {
  it.each([
    ["codex", "installCodex"],
    ["claude-code", "installClaude"],
  ] as const)("invokes only the fixed %s installer and re-probes after success", async (provider, expectedInstaller) => {
    const sent: RuntimeInstallResultFrame[] = [];
    const installClaude = vi.fn().mockResolvedValue({ ok: true, installedVersion: "2.1.0" });
    const installCodex = vi.fn().mockResolvedValue({ ok: true, installedVersion: "0.140.0" });
    const reprobe = vi.fn().mockResolvedValue(undefined);
    const runner = createRuntimeInstallRunner({
      installClaude,
      installCodex,
      reprobe,
      send: (result) => sent.push(result),
      log: vi.fn(),
    });

    await runner.run({ ...CODEX, provider });

    expect(installCodex).toHaveBeenCalledTimes(expectedInstaller === "installCodex" ? 1 : 0);
    expect(installClaude).toHaveBeenCalledTimes(expectedInstaller === "installClaude" ? 1 : 0);
    expect(reprobe).toHaveBeenCalledWith(provider);
    expect(sent.map((result) => result.status)).toEqual(["accepted", "in-progress", "succeeded"]);
  });

  it("rejects a concurrent duplicate without spawning another install and allows retry after failure", async () => {
    const first = deferred<{ ok: false; reason: string; retryable: boolean; reasonCode: string }>();
    const sent: RuntimeInstallResultFrame[] = [];
    const installCodex = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ok: true, installedVersion: "0.140.0" });
    const runner = createRuntimeInstallRunner({
      installClaude: vi.fn(),
      installCodex,
      reprobe: vi.fn().mockResolvedValue(undefined),
      send: (result) => sent.push(result),
      log: vi.fn(),
    });

    const running = runner.run(CODEX);
    await runner.run({ ...CODEX, ref: "223e4567-e89b-42d3-a456-426614174000" });
    expect(installCodex).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toMatchObject({ status: "failed", reasonCode: "already_in_progress", retryable: true });

    first.resolve({ ok: false, reason: "network down", retryable: true, reasonCode: "network_error" });
    await running;
    await runner.run({ ...CODEX, ref: "323e4567-e89b-42d3-a456-426614174000" });
    expect(installCodex).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toMatchObject({ status: "succeeded" });
  });

  it("surfaces installer and capability re-probe failures as retryable terminal results", async () => {
    const sent: RuntimeInstallResultFrame[] = [];
    const runner = createRuntimeInstallRunner({
      installClaude: vi.fn(),
      installCodex: vi.fn().mockResolvedValue({ ok: true, installedVersion: null }),
      reprobe: vi.fn().mockRejectedValue(new Error("probe unavailable")),
      send: (result) => sent.push(result),
      log: vi.fn(),
    });

    await runner.run(CODEX);
    expect(sent.at(-1)).toMatchObject({
      status: "failed",
      reasonCode: "capability_reprobe_failed",
      retryable: true,
    });
  });

  it("redacts secrets before publishing installer failures", async () => {
    const sent: RuntimeInstallResultFrame[] = [];
    const runner = createRuntimeInstallRunner({
      installClaude: vi.fn(),
      installCodex: vi.fn().mockResolvedValue({
        ok: false,
        reason: "registry rejected token=ghp_AbCdEf0123456789abcdef0123456789abcd",
        reasonCode: "npm_auth",
        retryable: false,
      }),
      reprobe: vi.fn(),
      send: (result) => sent.push(result),
      log: vi.fn(),
    });

    await runner.run(CODEX);
    expect(sent.at(-1)).toMatchObject({ status: "failed", reasonCode: "npm_auth" });
    expect(sent.at(-1)).not.toEqual(expect.objectContaining({ reason: expect.stringContaining("ghp_") }));
  });
});
