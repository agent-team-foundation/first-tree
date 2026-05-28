import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runGitHubScanMock = vi.fn();

describe("github-scan package CLI entrypoint", () => {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = [...originalArgv];
    process.exitCode = originalExitCode;
    vi.doMock("../../src/github-scan/cli.js", () => ({
      runGitHubScan: runGitHubScanMock,
    }));
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("delegates runCli arguments to runGitHubScan with console output", async () => {
    runGitHubScanMock.mockResolvedValue(5);
    const { runCli } = await import("../../src/cli.js");

    await expect(runCli(["doctor", "--home", "/tmp/home"])).resolves.toBe(5);

    expect(runGitHubScanMock).toHaveBeenCalledWith(["doctor", "--home", "/tmp/home"], expect.any(Function));
  });

  it("sets process.exitCode when imported as the process entrypoint", async () => {
    runGitHubScanMock.mockResolvedValue(7);
    const moduleUrl = new URL("../../src/cli.ts", import.meta.url);
    process.argv = ["node", fileURLToPath(moduleUrl), "status"];

    await import(`${moduleUrl.href}?main=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runGitHubScanMock).toHaveBeenCalledWith(["status"], expect.any(Function));
    expect(process.exitCode).toBe(7);
  });
});
