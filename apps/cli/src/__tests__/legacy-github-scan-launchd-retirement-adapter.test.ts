import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  userInfo: vi.fn(),
  spawnSync: vi.fn(() => {
    throw new Error("production spawn must not run in this test");
  }),
}));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, userInfo: adapterMocks.userInfo };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: adapterMocks.spawnSync };
});

vi.mock("../core/channel.js", () => ({
  channelConfig: { channel: "staging" },
}));

import { runLegacyGithubScanLaunchdRetirementOnce } from "../core/legacy-github-scan-launchd-retirement.js";

describe("legacy github-scan launchd production adapter", () => {
  const effectiveHome = mkdtempSync(join(tmpdir(), "first-tree-legacy-adapter-"));

  afterAll(() => {
    rmSync(effectiveHome, { recursive: true, force: true });
  });

  it("uses the effective-account home and memoizes without touching live launchctl", () => {
    adapterMocks.userInfo.mockReturnValue({
      uid: 501,
      gid: 20,
      username: "qa",
      homedir: effectiveHome,
      shell: "/bin/zsh",
    });

    const first = runLegacyGithubScanLaunchdRetirementOnce();
    const second = runLegacyGithubScanLaunchdRetirementOnce();

    expect(first.status).toBe(process.platform === "darwin" ? "absent" : "not-applicable");
    expect(second).toBe(first);
    expect(adapterMocks.userInfo).toHaveBeenCalledTimes(1);
    expect(adapterMocks.spawnSync).not.toHaveBeenCalled();
  });
});
