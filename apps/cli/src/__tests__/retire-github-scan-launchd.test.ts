import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const userInfoMock = vi.hoisted(() => vi.fn(() => ({ uid: 501, username: "tester" })));
const homedirMock = vi.hoisted(() => vi.fn(() => "/tmp/unset"));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
    userInfo: userInfoMock,
  };
});

const PREFIX = "com.first-tree.github-scan.runner.";
const originalPlatform = process.platform;
const originalFirstTreeHome = process.env.FIRST_TREE_HOME;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

let home: string;
let prodHome: string;
let launchdDir: string;
let statePath: string;

function plistBody(label: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${label}</string>\n<key>KeepAlive</key><true/>\n</dict></plist>\n`
  );
}

function writePlist(fileName: string, body: string): string {
  mkdirSync(launchdDir, { recursive: true });
  const path = join(launchdDir, fileName);
  writeFileSync(path, body);
  return path;
}

async function loadModule(): Promise<typeof import("../core/retire-github-scan-launchd.js")> {
  return await import("../core/retire-github-scan-launchd.js");
}

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "ft-retire-"));
  prodHome = join(home, ".first-tree");
  launchdDir = join(prodHome, "github-scan", "runner", "launchd");
  statePath = join(prodHome, "state", "legacy-github-scan-launchd.json");
  homedirMock.mockReturnValue(home);
  userInfoMock.mockClear();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  process.env.FIRST_TREE_HOME = join(home, "channel-home");
  setPlatform("darwin");
});

afterEach(() => {
  setPlatform(originalPlatform);
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
});

describe("retireLegacyGithubScanLaunchd", () => {
  it("returns empty and spawns nothing off darwin", async () => {
    setPlatform("linux");
    writePlist("a.plist", plistBody(`${PREFIX}alice.default`));
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    expect(retireLegacyGithubScanLaunchd({ homeDir: prodHome })).toEqual({
      bootedOut: [],
      removedPlists: 0,
      skipped: [],
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns empty when the legacy directory is missing", async () => {
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    expect(retireLegacyGithubScanLaunchd({ homeDir: prodHome })).toEqual({
      bootedOut: [],
      removedPlists: 0,
      skipped: [],
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("boots out a matching label, removes the plist, and prunes the empty dir", async () => {
    const label = `${PREFIX}alice.default`;
    const path = writePlist(`${label}.plist`, plistBody(label));
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    const result = retireLegacyGithubScanLaunchd({ homeDir: prodHome });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "launchctl",
      ["bootout", `gui/501/${label}`],
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(result).toEqual({ bootedOut: [label], removedPlists: 1, skipped: [] });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(launchdDir)).toBe(false);
  });

  it("processes every profile plist in the directory", async () => {
    const one = `${PREFIX}alice.default`;
    const two = `${PREFIX}alice.work_profile`;
    writePlist(`${one}.plist`, plistBody(one));
    writePlist(`${two}.plist`, plistBody(two));
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    const result = retireLegacyGithubScanLaunchd({ homeDir: prodHome });
    expect(result.bootedOut.sort()).toEqual([one, two]);
    expect(result.removedPlists).toBe(2);
    expect(existsSync(launchdDir)).toBe(false);
  });

  it("skips a foreign label: no bootout, file and dir retained, reported in skipped", async () => {
    const path = writePlist("foreign.plist", plistBody("com.example.backup-agent"));
    const log = vi.fn();
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    const result = retireLegacyGithubScanLaunchd({ homeDir: prodHome, log });
    expect(result).toEqual({ bootedOut: [], removedPlists: 0, skipped: ["foreign.plist"] });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(launchdDir)).toBe(true);
    expect(log.mock.calls.join("\n")).toContain("outside the legacy github-scan namespace");
  });

  it("falls back to the filename stem for unparseable plists, still gated by the prefix", async () => {
    const stemLabel = `${PREFIX}bob.default`;
    writePlist(`${stemLabel}.plist`, "not xml at all");
    writePlist("junk.plist", "also not xml");
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    const result = retireLegacyGithubScanLaunchd({ homeDir: prodHome });
    expect(result.bootedOut).toEqual([stemLabel]);
    expect(result.skipped).toEqual(["junk.plist"]);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(existsSync(join(launchdDir, "junk.plist"))).toBe(true);
  });

  it("parses whitespace-padded Label entries", async () => {
    const label = `${PREFIX}carol.default`;
    writePlist("padded.plist", `<plist><dict><key> Label </key>\n  <string>  ${label}  </string></dict></plist>`);
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    expect(retireLegacyGithubScanLaunchd({ homeDir: prodHome }).bootedOut).toEqual([label]);
  });

  it("treats a not-loaded bootout as success and removes the plist", async () => {
    const label = `${PREFIX}dora.default`;
    const path = writePlist(`${label}.plist`, plistBody(label));
    spawnSyncMock.mockReturnValue({
      status: 3,
      stdout: "",
      stderr: `Boot-out failed: 3: Could not find service "${label}" in domain for user gui: 501`,
    });
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    const result = retireLegacyGithubScanLaunchd({ homeDir: prodHome });
    expect(result).toEqual({ bootedOut: [label], removedPlists: 1, skipped: [] });
    expect(existsSync(path)).toBe(false);
  });

  it("keeps the plist as a retry artifact on a hard bootout failure", async () => {
    const label = `${PREFIX}erin.default`;
    const path = writePlist(`${label}.plist`, plistBody(label));
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "Operation not permitted" });
    const log = vi.fn();
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    const result = retireLegacyGithubScanLaunchd({ homeDir: prodHome, log });
    expect(result).toEqual({ bootedOut: [], removedPlists: 0, skipped: [] });
    expect(existsSync(path)).toBe(true);
    expect(log.mock.calls.join("\n")).toContain("Operation not permitted");
  });

  it("leaves the directory in place when non-plist files remain", async () => {
    const label = `${PREFIX}finn.default`;
    writePlist(`${label}.plist`, plistBody(label));
    writeFileSync(join(launchdDir, "runner.log"), "old log");
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    const result = retireLegacyGithubScanLaunchd({ homeDir: prodHome });
    expect(result.removedPlists).toBe(1);
    expect(existsSync(launchdDir)).toBe(true);
  });

  it("is idempotent once the directory is clean", async () => {
    const label = `${PREFIX}gale.default`;
    writePlist(`${label}.plist`, plistBody(label));
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    retireLegacyGithubScanLaunchd({ homeDir: prodHome });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const second = retireLegacyGithubScanLaunchd({ homeDir: prodHome });
    expect(second).toEqual({ bootedOut: [], removedPlists: 0, skipped: [] });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("swallows spawnSync throws and keeps the plist", async () => {
    const label = `${PREFIX}hugo.default`;
    const path = writePlist(`${label}.plist`, plistBody(label));
    spawnSyncMock.mockImplementation(() => {
      throw new Error("launchctl missing");
    });
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    expect(() => retireLegacyGithubScanLaunchd({ homeDir: prodHome })).not.toThrow();
    expect(existsSync(path)).toBe(true);
  });

  it("stops at the overall deadline before spawning", async () => {
    const label = `${PREFIX}iris.default`;
    const path = writePlist(`${label}.plist`, plistBody(label));
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    const result = retireLegacyGithubScanLaunchd({ homeDir: prodHome, overallTimeoutMs: 0 });
    expect(result).toEqual({ bootedOut: [], removedPlists: 0, skipped: [] });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
  });

  it("clamps the per-label launchctl timeout to the caller's budget", async () => {
    const label = `${PREFIX}jack.default`;
    writePlist(`${label}.plist`, plistBody(label));
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    retireLegacyGithubScanLaunchd({ homeDir: prodHome, bootoutTimeoutMs: 7 });
    expect(spawnSyncMock).toHaveBeenCalledWith("launchctl", expect.anything(), expect.objectContaining({ timeout: 7 }));
  });

  it("targets the prod home by default, ignoring FIRST_TREE_HOME channel overrides", async () => {
    const label = `${PREFIX}kate.default`;
    writePlist(`${label}.plist`, plistBody(label));
    process.env.FIRST_TREE_HOME = join(home, "somewhere-else");
    const { retireLegacyGithubScanLaunchd } = await loadModule();
    const result = retireLegacyGithubScanLaunchd();
    expect(result.bootedOut).toEqual([label]);
    expect(existsSync(launchdDir)).toBe(false);
  });
});

describe("runLegacyGithubScanMigration", () => {
  it("runs at most once per process with the shared one-second budget", async () => {
    const label = `${PREFIX}luna.default`;
    writePlist(`${label}.plist`, plistBody(label));
    const { runLegacyGithubScanMigration } = await loadModule();
    const first = runLegacyGithubScanMigration();
    expect(first.bootedOut).toEqual([label]);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "launchctl",
      expect.anything(),
      expect.objectContaining({ timeout: 1_000 }),
    );
    const second = runLegacyGithubScanMigration();
    expect(second).toEqual({ bootedOut: [], removedPlists: 0, skipped: [] });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("honors an unexpired cooldown stamp", async () => {
    const label = `${PREFIX}mona.default`;
    writePlist(`${label}.plist`, plistBody(label));
    mkdirSync(join(prodHome, "state"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ retryAfterMs: 2_000 }));
    const { runLegacyGithubScanMigration } = await loadModule();
    const result = runLegacyGithubScanMigration({ nowMs: 1_000 });
    expect(result).toEqual({ bootedOut: [], removedPlists: 0, skipped: [] });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("stamps a cooldown while a plist survives a failed bootout", async () => {
    const label = `${PREFIX}nils.default`;
    writePlist(`${label}.plist`, plistBody(label));
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "Operation not permitted" });
    const { runLegacyGithubScanMigration } = await loadModule();
    runLegacyGithubScanMigration({ nowMs: 1_000, retryIntervalMs: 500 });
    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({ retryAfterMs: 1_500 });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("counts skipped foreign plists toward the cooldown", async () => {
    writePlist("foreign.plist", plistBody("com.example.backup-agent"));
    const { runLegacyGithubScanMigration } = await loadModule();
    runLegacyGithubScanMigration({ nowMs: 1_000, retryIntervalMs: 500 });
    expect(existsSync(statePath)).toBe(true);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("removes a stale cooldown stamp once the directory is clean", async () => {
    mkdirSync(join(prodHome, "state"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ retryAfterMs: 0 }));
    const { runLegacyGithubScanMigration } = await loadModule();
    runLegacyGithubScanMigration({ nowMs: 1_000 });
    expect(existsSync(statePath)).toBe(false);
  });

  it("proceeds with one bounded attempt after an unreadable stamp", async () => {
    const label = `${PREFIX}olga.default`;
    writePlist(`${label}.plist`, plistBody(label));
    mkdirSync(join(prodHome, "state"), { recursive: true });
    writeFileSync(statePath, "{ not json");
    const { runLegacyGithubScanMigration } = await loadModule();
    const result = runLegacyGithubScanMigration();
    expect(result.bootedOut).toEqual([label]);
  });

  it("does nothing off darwin", async () => {
    setPlatform("win32");
    writePlist("a.plist", plistBody(`${PREFIX}pete.default`));
    const { runLegacyGithubScanMigration } = await loadModule();
    expect(runLegacyGithubScanMigration()).toEqual({ bootedOut: [], removedPlists: 0, skipped: [] });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(existsSync(statePath)).toBe(false);
  });
});

describe("checkLegacyGithubScanRunner", () => {
  it("is not applicable off darwin", async () => {
    setPlatform("linux");
    const { checkLegacyGithubScanRunner } = await import("../core/doctor.js");
    expect(checkLegacyGithubScanRunner()).toEqual({
      label: "Legacy github-scan",
      ok: true,
      detail: "not applicable on linux",
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("flags disk residue with the manual bootout hint", async () => {
    const label = `${PREFIX}rhea.default`;
    writePlist(`${label}.plist`, plistBody(label));
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "PID\tStatus\tLabel\n123\t0\tcom.apple.Finder\n", stderr: "" });
    const { checkLegacyGithubScanRunner } = await import("../core/doctor.js");
    const result = checkLegacyGithubScanRunner();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(label);
    expect(result.detail).toContain("launchctl bootout gui/$(id -u)/<label>");
    expect(spawnSyncMock).toHaveBeenCalledWith("launchctl", ["list"], expect.anything());
  });

  it("flags session zombies that only launchctl still knows about", async () => {
    const label = `${PREFIX}sara.default`;
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: `PID\tStatus\tLabel\n-\t0\t${label}\n123\t0\tcom.apple.Finder\n`,
      stderr: "",
    });
    const { checkLegacyGithubScanRunner } = await import("../core/doctor.js");
    const result = checkLegacyGithubScanRunner();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(label);
  });

  it("stays ok with a note about unrelated plists left untouched", async () => {
    writePlist("foreign.plist", plistBody("com.example.backup-agent"));
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "PID\tStatus\tLabel\n", stderr: "" });
    const { checkLegacyGithubScanRunner } = await import("../core/doctor.js");
    const result = checkLegacyGithubScanRunner();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("1 unrelated plist(s)");
  });

  it("degrades to the disk verdict when launchctl is unavailable", async () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("spawn launchctl ENOENT");
    });
    const { checkLegacyGithubScanRunner } = await import("../core/doctor.js");
    const result = checkLegacyGithubScanRunner();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("launchctl scan unavailable");
  });
});
