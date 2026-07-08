import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childRegistryMocks = vi.hoisted(() => ({
  classify: vi.fn(),
  ERROR_KINDS: { TRANSIENT: "transient", PERMANENT: "permanent" },
  getChildProcessRegistry: vi.fn(),
}));
const cliFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@first-tree/client", () => childRegistryMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));

let tmpDirs: string[] = [];
const originalPlatform = process.platform;

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  return dir;
}

function currentPlatform(): string | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  if (process.arch !== "x64" && process.arch !== "arm64") return null;
  return `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`;
}

function bytes(path: string): number {
  return statSync(path).size;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function makeArtifactPayload(options: {
  version: string;
  platform: string;
  nodeVersion?: string;
  packageName?: string;
  binName?: string;
  aliasName?: string;
  installOverrides?: Record<string, unknown>;
}): Promise<string> {
  const payload = tempDir("ft-portable-payload-");
  const nodeVersion = options.nodeVersion ?? "v24.0.0";
  const packageName = options.packageName ?? "first-tree";
  const binName = options.binName ?? "first-tree";
  const aliasName = options.aliasName ?? "ft";
  await mkdir(join(payload, "node", "bin"), { recursive: true });
  await mkdir(join(payload, "app", "cli"), { recursive: true });
  await mkdir(join(payload, "bin"), { recursive: true });
  await writeFile(join(payload, "node", "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(payload, "app", "cli", "index.mjs"), "// fixture\n");
  await writeFile(
    join(payload, "app", "package.json"),
    JSON.stringify({ name: packageName, version: options.version }),
  );
  await writeFile(join(payload, "VERSION"), `${options.version}\n`);
  await writeFile(
    join(payload, "INSTALL.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        channel: "prod",
        version: options.version,
        gitSha: "abc123",
        nodeVersion,
        packageName,
        binName,
        aliasName,
        generatedAt: new Date().toISOString(),
        platform: options.platform,
        installMode: "portable",
        appEntry: "app/cli/index.mjs",
        ...options.installOverrides,
      },
      null,
      2,
    ),
  );
  await writeFile(join(payload, "bin", binName), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(payload, "bin", aliasName), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return payload;
}

async function makePortableFixture(
  options: {
    version?: string;
    nodeVersion?: string;
    packageName?: string;
    binName?: string;
    aliasName?: string;
    installOverrides?: Record<string, unknown>;
  } = {},
): Promise<{ root: string; latestPath: string; manifestPath: string; tarball: string; platform: string }> {
  const platform = currentPlatform();
  if (platform === null) throw new Error("unsupported test platform");
  const version = options.version ?? "1.2.3";
  const nodeVersion = options.nodeVersion ?? "v24.0.0";
  const packageName = options.packageName ?? "first-tree";
  const binName = options.binName ?? "first-tree";
  const aliasName = options.aliasName ?? "ft";
  const root = tempDir("ft-portable-fixture-");
  const channelDir = join(root, "prod");
  const versionDir = join(channelDir, version);
  mkdirSync(versionDir, { recursive: true });

  const payload = await makeArtifactPayload({
    version,
    platform,
    nodeVersion,
    packageName,
    binName,
    aliasName,
    installOverrides: options.installOverrides,
  });
  const tarball = join(versionDir, `${packageName}-${version}-${platform}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", tarball, "-C", payload, "."], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(tar.stderr);

  const base = {
    schemaVersion: 1,
    channel: "prod",
    version,
    gitSha: "abc123",
    nodeVersion,
    packageName,
    binName,
    aliasName,
    generatedAt: new Date().toISOString(),
  };
  const asset = {
    platform,
    fileName: `${packageName}-${version}-${platform}.tar.gz`,
    url: `file://${tarball}`,
    sha256: sha256(tarball),
    size: bytes(tarball),
  };
  const latestPath = join(channelDir, "latest.json");
  const manifestPath = join(versionDir, "manifest.json");
  writeFileSync(
    latestPath,
    JSON.stringify({ ...base, manifestUrl: `file://${manifestPath}`, assets: [asset] }, null, 2),
  );
  writeFileSync(manifestPath, JSON.stringify({ ...base, assets: [asset] }, null, 2));
  return { root, latestPath, manifestPath, tarball, platform };
}

async function seedOldInstall(prefix: string, options: { nodeVersion?: string } = {}): Promise<void> {
  const nodeVersion = options.nodeVersion ?? "v24.0.0";
  await mkdir(join(prefix, "versions", "old"), { recursive: true });
  await writeFile(join(prefix, "versions", "old", "VERSION"), "old\n");
  await writeFile(
    join(prefix, "versions", "old", "INSTALL.json"),
    JSON.stringify({
      schemaVersion: 1,
      channel: "prod",
      version: "0.1.0",
      gitSha: "old",
      nodeVersion,
      packageName: "first-tree",
      binName: "first-tree",
      aliasName: "ft",
      generatedAt: new Date().toISOString(),
      platform: currentPlatform(),
      installMode: "portable",
      appEntry: "app/cli/index.mjs",
    }),
  );
  await symlink(join(prefix, "versions", "old"), join(prefix, "current"));
}

async function importProdUpdateModule(
  overrides: { channelPrefix?: string | null; downloadBaseUrl?: string | null } = {},
): Promise<typeof import("../core/update.js")> {
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
        channelPrefix: overrides.channelPrefix === undefined ? "prod" : overrides.channelPrefix,
        publicInstallerPath: "prod/install.sh",
        downloadBaseUrl:
          overrides.downloadBaseUrl === undefined
            ? "https://download.first-tree.ai/releases"
            : overrides.downloadBaseUrl,
      },
    },
  }));
  return import("../core/update.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  childRegistryMocks.classify.mockReturnValue({ kind: "permanent", reasonCode: "classified" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../core/channel.js");
  vi.doUnmock("node:fs/promises");
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("installPortableSpec", () => {
  it("rejects invalid specs and disabled portable metadata configuration", async () => {
    const prod = await importProdUpdateModule();
    await expect(prod.installPortableSpec("not-a-version")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: expect.stringContaining("invalid portable version"),
    });

    const noChannel = await importProdUpdateModule({ channelPrefix: null });
    await expect(noChannel.fetchPortableLatestVersion()).resolves.toEqual({
      ok: false,
      reason: "self-update disabled: this binary's channel does not publish portable artifacts.",
    });

    const noBaseUrl = await importProdUpdateModule({ downloadBaseUrl: null });
    await expect(noBaseUrl.fetchPortableLatestVersion()).resolves.toEqual({
      ok: false,
      reason: "self-update disabled: portable download base URL is not configured for this channel.",
    });
  });

  it("surfaces HTTP metadata download failures for portable latest checks", async () => {
    const platform = currentPlatform() ?? "linux-x64";
    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn(async () =>
        JSON.stringify({
          schemaVersion: 1,
          channel: "prod",
          version: "3.1.4",
          gitSha: "abc123",
          nodeVersion: "v24.0.0",
          packageName: "first-tree",
          binName: "first-tree",
          aliasName: "ft",
          generatedAt: new Date().toISOString(),
          manifestUrl: "https://download.example/releases/prod/3.1.4/manifest.json",
          assets: [
            {
              platform,
              fileName: `first-tree-3.1.4-${platform}.tar.gz`,
              url: "https://download.example/payload.tar.gz",
              sha256: "0".repeat(64),
              size: 123,
            },
          ],
        }),
      ),
    });
    const http = await importProdUpdateModule({ downloadBaseUrl: "https://download.example/releases/" });

    await expect(http.fetchPortableLatestVersion()).resolves.toEqual({ ok: true, version: "3.1.4" });

    cliFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn(async () => "unavailable"),
    });

    await expect(http.fetchPortableLatestVersion()).resolves.toEqual({
      ok: false,
      reason: "download failed for https://download.example/releases/prod/latest.json: HTTP 503",
    });

    cliFetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(http.fetchPortableLatestVersion()).resolves.toEqual({ ok: false, reason: "network down" });
  });

  it("fails closed when portable self-update is unsupported on this platform", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const prod = await importProdUpdateModule();

    await expect(prod.installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: expect.stringContaining("portable self-update is not supported on win32"),
    });
  });

  it("installs latest from file metadata, switches current, and rewrites shims", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "first-tree"), "#!/bin/sh\nexit 0\n");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

    const { installPortableSpec } = await importProdUpdateModule();
    await expect(installPortableSpec("latest")).resolves.toEqual({
      ok: true,
      mode: "portable",
      installedVersion: "1.2.3",
    });

    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
    const shim = readFileSync(join(binDir, "first-tree"), "utf8");
    expect(shim).toContain("FIRST_TREE_INSTALL_MODE=portable");
    expect(shim).toContain(`FIRST_TREE_PORTABLE_ROOT="$root"`);
    expect(readFileSync(join(binDir, "ft"), "utf8")).toContain('root="');
  });

  it("downloads portable payloads over HTTP and writes fallback shims when PATH has no existing shim", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as {
      assets: Array<{ url: string }>;
    };
    latest.assets[0].url = "https://download.example/payload.tar.gz";
    writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
    const payload = readFileSync(fixture.tarball);
    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: vi.fn(async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)),
    });
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", "/usr/bin:/bin");

    const { installPortableSpec } = await importProdUpdateModule();
    await expect(installPortableSpec("latest")).resolves.toEqual({
      ok: true,
      mode: "portable",
      installedVersion: "1.2.3",
    });

    expect(readFileSync(join(home, ".local", "bin", "first-tree"), "utf8")).toContain("FIRST_TREE_PORTABLE_ROOT");
    expect(readFileSync(join(home, ".local", "bin", "ft"), "utf8")).toContain("FIRST_TREE_PORTABLE_ROOT");
  });

  it("installs exact versions from immutable manifests", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture({ version: "2.0.0" });
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);

    const { installPortableSpec } = await importProdUpdateModule();
    const result = await installPortableSpec("2.0.0");
    expect(result).toEqual({ ok: true, mode: "portable", installedVersion: "2.0.0" });
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("2.0.0\n");
  });

  it("hands portable installs across bundled Node major upgrades", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture({ version: "2.0.0", nodeVersion: "v25.0.0" });
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix, { nodeVersion: "v24.11.1" });
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);

    const { installPortableSpec } = await importProdUpdateModule();
    const result = await installPortableSpec("latest");
    expect(result).toEqual({ ok: true, mode: "portable", installedVersion: "2.0.0" });

    const currentInstall = JSON.parse(readFileSync(join(prefix, "current", "INSTALL.json"), "utf8")) as {
      nodeVersion: string;
    };
    const oldInstall = JSON.parse(readFileSync(join(prefix, "versions", "old", "INSTALL.json"), "utf8")) as {
      nodeVersion: string;
    };
    expect(oldInstall.nodeVersion).toBe("v24.11.1");
    expect(currentInstall.nodeVersion).toBe("v25.0.0");
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("2.0.0\n");
  });

  it("leaves current intact on checksum mismatch and malformed metadata", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as { assets: Array<{ sha256: string }> };
    latest.assets[0].sha256 = "0".repeat(64);
    writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    const badChecksum = await installPortableSpec("latest");
    expect(badChecksum.ok).toBe(false);
    if (badChecksum.ok) throw new Error("expected checksum failure");
    expect(badChecksum.reason).toContain("checksum mismatch");
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");

    writeFileSync(fixture.latestPath, "{not-json");
    const malformed = await installPortableSpec("latest");
    expect(malformed.ok).toBe(false);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
  });

  it("rejects channel, package, bin, alias, version-channel, and asset name mismatches", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));

    const { installPortableSpec } = await importProdUpdateModule();
    for (const patch of [
      { channel: "staging", version: "1.2.3-staging.1.1" },
      { packageName: "first-tree-staging" },
      { binName: "first-tree-staging" },
      { aliasName: "first-tree-staging" },
      { version: "1.2.3-staging.1.1" },
    ]) {
      const fixture = await makePortableFixture();
      const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as Record<string, unknown>;
      Object.assign(latest, patch);
      writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
      vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
      const result = await installPortableSpec("latest");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected mismatch failure");
      expect(result.reason).toMatch(/Refusing to install portable update|invalid/i);
      expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
    }

    const fixture = await makePortableFixture();
    const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as {
      assets: Array<{ fileName: string }>;
    };
    latest.assets[0].fileName = "../payload.tar.gz";
    writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    const badAsset = await installPortableSpec("latest");
    expect(badAsset.ok).toBe(false);
    if (badAsset.ok) throw new Error("expected unsafe asset failure");
    expect(badAsset.reason).toContain("portable asset fileName is not a safe basename");
  });

  it("rejects extracted INSTALL.json mismatches", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const cases: Array<{ installOverrides: Record<string, unknown>; expected: string }> = [
      { installOverrides: { version: "9.9.9" }, expected: 'version "9.9.9" does not match metadata version "1.2.3"' },
      {
        installOverrides: { platform: platform === "linux-x64" ? "darwin-x64" : "linux-x64" },
        expected: "platform",
      },
      { installOverrides: { appEntry: "dist/index.mjs" }, expected: "appEntry" },
    ];

    const { installPortableSpec } = await importProdUpdateModule();
    for (const testCase of cases) {
      const fixture = await makePortableFixture({ installOverrides: testCase.installOverrides });
      const home = tempDir("ft-portable-home-");
      const prefix = join(home, "prefix");
      await seedOldInstall(prefix);
      vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
      vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

      const result = await installPortableSpec("latest");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected extracted metadata failure");
      expect(result.reason).toContain(testCase.expected);
      expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
    }
  });

  it("returns classified portable failures for bad tarballs and invalid current links", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    childRegistryMocks.classify.mockReturnValue({ kind: "transient", reasonCode: "classified_transient" });
    const badTar = await makePortableFixture();
    const invalidTarball = join(badTar.root, "prod", "1.2.3", "not-a-tar.gz");
    writeFileSync(invalidTarball, "not a gzip payload");
    const latest = JSON.parse(readFileSync(badTar.latestPath, "utf8")) as {
      assets: Array<{ fileName: string; url: string; sha256: string; size: number }>;
    };
    latest.assets[0].fileName = "not-a-tar.gz";
    latest.assets[0].url = `file://${invalidTarball}`;
    latest.assets[0].sha256 = sha256(invalidTarball);
    latest.assets[0].size = bytes(invalidTarball);
    writeFileSync(badTar.latestPath, JSON.stringify(latest, null, 2));
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${badTar.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    const tarFailure = await installPortableSpec("latest");
    expect(tarFailure).toMatchObject({
      ok: false,
      mode: "portable",
      retryable: true,
      reasonCode: "classified_transient",
    });
    if (tarFailure.ok) throw new Error("expected tar failure");
    expect(tarFailure.reason).toContain("tar exited with code");

    const badCurrent = await makePortableFixture({ version: "2.0.0" });
    const secondHome = tempDir("ft-portable-home-");
    const secondPrefix = join(secondHome, "prefix");
    mkdirSync(join(secondPrefix, "current"), { recursive: true });
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(secondPrefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${badCurrent.root}`);
    const currentFailure = await installPortableSpec("latest");
    expect(currentFailure.ok).toBe(false);
    if (currentFailure.ok) throw new Error("expected current symlink failure");
    expect(currentFailure.reason).toContain("exists and is not a symlink");
  });

  it("reports missing extracted INSTALL metadata and current symlink replacement cleanup failures", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    childRegistryMocks.classify.mockReturnValue({ kind: "transient", reasonCode: "classified_transient" });

    const missingInstall = await makePortableFixture();
    const payload = tempDir("ft-portable-no-install-");
    await mkdir(join(payload, "node", "bin"), { recursive: true });
    await mkdir(join(payload, "app", "cli"), { recursive: true });
    await writeFile(join(payload, "node", "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(payload, "app", "cli", "index.mjs"), "// fixture\n");
    const tarball = join(missingInstall.root, "prod", "1.2.3", `missing-install-${platform}.tar.gz`);
    const tar = spawnSync("tar", ["-czf", tarball, "-C", payload, "."], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(tar.stderr);
    const latest = JSON.parse(readFileSync(missingInstall.latestPath, "utf8")) as {
      assets: Array<{ fileName: string; url: string; sha256: string; size: number }>;
    };
    latest.assets[0].fileName = `missing-install-${platform}.tar.gz`;
    latest.assets[0].url = `file://${tarball}`;
    latest.assets[0].sha256 = sha256(tarball);
    latest.assets[0].size = bytes(tarball);
    writeFileSync(missingInstall.latestPath, JSON.stringify(latest, null, 2));
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${missingInstall.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    const missing = await installPortableSpec("latest");
    expect(missing).toMatchObject({
      ok: false,
      mode: "portable",
      retryable: true,
      reasonCode: "classified_transient",
    });
    if (missing.ok) throw new Error("expected missing INSTALL failure");
    expect(missing.reason).toContain("extracted artifact missing or invalid INSTALL.json");

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        rename: async (oldPath: string, newPath: string) => {
          if (oldPath.includes(".current.") && newPath.endsWith("/current")) {
            throw new Error("rename current denied");
          }
          return actual.rename(oldPath, newPath);
        },
      };
    });
    const renameFixture = await makePortableFixture({ version: "4.0.0" });
    const secondHome = tempDir("ft-portable-home-");
    const secondPrefix = join(secondHome, "prefix");
    await seedOldInstall(secondPrefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(secondPrefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${renameFixture.root}`);
    const renameModule = await importProdUpdateModule();
    const renameFailure = await renameModule.installPortableSpec("latest");
    expect(renameFailure.ok).toBe(false);
    if (renameFailure.ok) throw new Error("expected current rename failure");
    expect(renameFailure.reason).toContain("rename current denied");
  });

  it("fetches portable latest metadata for manual upgrade checks", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture({ version: "3.0.0" });
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { fetchPortableLatestVersion } = await importProdUpdateModule();
    await expect(fetchPortableLatestVersion()).resolves.toEqual({ ok: true, version: "3.0.0" });
  });
});
