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

vi.mock("@first-tree/client", () => childRegistryMocks);

let tmpDirs: string[] = [];

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
    JSON.stringify({
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
    }),
  );
  await writeFile(join(payload, "bin", binName), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(payload, "bin", aliasName), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return payload;
}

async function makePortableFixture(
  options: { version?: string; nodeVersion?: string; packageName?: string; binName?: string; aliasName?: string } = {},
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

  const payload = await makeArtifactPayload({ version, platform, nodeVersion, packageName, binName, aliasName });
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

async function importProdUpdateModule(): Promise<typeof import("../core/update.js")> {
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
        channelPrefix: "prod",
        publicInstallerPath: "prod/install.sh",
        downloadBaseUrl: "https://downloads.first-tree.ai",
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
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("installPortableSpec", () => {
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

  it("rejects channel, package, and bin mismatches", async () => {
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
