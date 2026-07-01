import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { artifactFileName, parsePlatform, validateChannelVersion } from "../../../scripts/portable/build-portable.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let tmpDirs: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("portable builder helpers", () => {
  it("validates channel/version pairs", () => {
    expect(() => validateChannelVersion("prod", "1.2.3")).not.toThrow();
    expect(() => validateChannelVersion("prod", "1.2.3-staging.4.1")).toThrow(/stable/);
    expect(() => validateChannelVersion("staging", "1.2.4-staging.4.1")).not.toThrow();
    expect(() => validateChannelVersion("staging", "1.2.4")).toThrow(/-staging/);
  });

  it("maps supported platform strings", () => {
    expect(parsePlatform("linux-x64")).toEqual({ os: "linux", arch: "x64" });
    expect(parsePlatform("darwin-arm64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(() => parsePlatform("win32-x64")).toThrow(/unsupported/);
  });

  it("uses immutable artifact names", () => {
    expect(artifactFileName({ packageName: "first-tree", version: "1.2.3", platform: "linux-x64" })).toBe(
      "first-tree-1.2.3-linux-x64.tar.gz",
    );
  });
});

describe("portable installer", () => {
  async function writeFixtureVersion(root: string, version: string): Promise<void> {
    const channelDir = join(root, "prod");
    const versionDir = join(channelDir, version);
    const payload = join(root, `payload-${version}`);
    await mkdir(join(payload, "node", "bin"), { recursive: true });
    await mkdir(join(payload, "app", "cli"), { recursive: true });
    await mkdir(join(payload, "bin"), { recursive: true });
    await writeFile(
      join(payload, "node", "bin", "node"),
      `#!/bin/sh\nif [ "$2" = "--version" ]; then echo ${version}; exit 0; fi\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\necho node-stub "$@"\n`,
      { mode: 0o755 },
    );
    await writeFile(join(payload, "app", "cli", "index.mjs"), "// fixture\n");
    await writeFile(join(payload, "app", "package.json"), JSON.stringify({ name: "first-tree", version }));
    await writeFile(join(payload, "VERSION"), `${version}\n`);
    await writeFile(
      join(payload, "INSTALL.json"),
      JSON.stringify({
        schemaVersion: 1,
        channel: "prod",
        version,
        gitSha: "abc123",
        nodeVersion: "v24.0.0",
        packageName: "first-tree",
        binName: "first-tree",
        aliasName: "ft",
        generatedAt: new Date().toISOString(),
        platform: "linux-x64",
        installMode: "portable",
        appEntry: "app/cli/index.mjs",
      }),
    );
    await writeFile(
      join(payload, "bin", "first-tree"),
      '#!/bin/sh\nroot=$(CDPATH= cd "$(dirname "$0")/.." && pwd)\nexec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(payload, "bin", "ft"),
      '#!/bin/sh\nroot=$(CDPATH= cd "$(dirname "$0")/.." && pwd)\nexec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"\n',
      { mode: 0o755 },
    );
    await mkdir(versionDir, { recursive: true });
    const tarball = join(versionDir, `first-tree-${version}-linux-x64.tar.gz`);
    const tar = spawnSync("tar", ["-czf", tarball, "-C", payload, "."], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(tar.stderr);
    const sha = spawnSync("sha256sum", [tarball], { encoding: "utf8" }).stdout.split(/\s+/)[0];
    const latest = {
      schemaVersion: 1,
      channel: "prod",
      version,
      gitSha: "abc123",
      nodeVersion: "v24.0.0",
      packageName: "first-tree",
      binName: "first-tree",
      aliasName: "ft",
      generatedAt: new Date().toISOString(),
      manifestUrl: `file://${versionDir}/manifest.json`,
      assets: [
        {
          platform: "linux-x64",
          fileName: `first-tree-${version}-linux-x64.tar.gz`,
          url: `file://${tarball}`,
          sha256: sha,
          size: Number.parseInt(spawnSync("wc", ["-c", tarball], { encoding: "utf8" }).stdout, 10),
        },
      ],
    };
    writeFileSync(join(channelDir, "latest.json"), JSON.stringify(latest, null, 2));
    writeFileSync(join(versionDir, "manifest.json"), JSON.stringify({ ...latest, manifestUrl: undefined }, null, 2));
  }

  async function makeFixture(): Promise<string> {
    const root = tempDir("first-tree-install-test-");
    await writeFixtureVersion(root, "1.2.3");
    return root;
  }

  it("installs from a local manifest and writes portable shims", async () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    const fixture = await makeFixture();
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const res = spawnSync(
      "sh",
      [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir, "--no-path-edit"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
        },
        encoding: "utf8",
      },
    );
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
    const shim = readFileSync(join(binDir, "first-tree"), "utf8");
    expect(shim).toContain("FIRST_TREE_INSTALL_MODE=portable");
    expect(shim).toContain("FIRST_TREE_PORTABLE_ROOT");
  });

  it("replaces the current symlink itself when upgrading with the shell installer", async () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    const fixture = await makeFixture();
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const installArgs = [
      join(REPO_ROOT, "scripts", "portable", "install.sh"),
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
      "--no-path-edit",
    ];
    const env = {
      ...process.env,
      HOME: home,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
    };

    const firstInstall = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(firstInstall.status, firstInstall.stderr || firstInstall.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");

    await writeFixtureVersion(fixture, "1.2.4");
    const secondInstall = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });

    expect(secondInstall.status, secondInstall.stderr || secondInstall.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.4\n");
    expect(readdirSync(join(prefix, "versions", "1.2.3")).filter((entry) => entry.startsWith(".current."))).toEqual([]);
  });

  it("leaves the previous current symlink intact on checksum failure", async () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    const fixture = await makeFixture();
    const latestPath = join(fixture, "prod", "latest.json");
    const latest = JSON.parse(readFileSync(latestPath, "utf8")) as { assets: Array<{ sha256: string }> };
    latest.assets[0].sha256 = "0".repeat(64);
    writeFileSync(latestPath, JSON.stringify(latest, null, 2));
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    await mkdir(join(prefix, "versions", "old"), { recursive: true });
    await writeFile(join(prefix, "versions", "old", "VERSION"), "old\n");
    await symlink(join(prefix, "versions", "old"), join(prefix, "current"));
    const res = spawnSync(
      "sh",
      [
        join(REPO_ROOT, "scripts", "portable", "install.sh"),
        "--prefix",
        prefix,
        "--bin-dir",
        join(home, "bin"),
        "--no-path-edit",
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home, FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}` },
        encoding: "utf8",
      },
    );
    expect(res.status).not.toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
  });
});
