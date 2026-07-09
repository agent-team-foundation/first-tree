import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactDownloadUrl,
  artifactFileName,
  assertNoBuildRootReferences,
  buildPortableReleaseMetadata,
  copyPortableAppTemplate,
  DEFAULT_DOWNLOAD_BASE_URL,
  DEFAULT_NODE_VERSION,
  manifestDownloadUrl,
  NODE_VERSION_FILE,
  normalizeDownloadBaseUrl,
  normalizeGeneratedAt,
  normalizeNodeVersion,
  PORTABLE_LOCKFILE_INSTALL_ARGS,
  PORTABLE_NODE_MODULES_INSTALL_ARGS,
  packageJsonForApp,
  parsePlatform,
  portableBuildRoots,
  portableTarCreateArgs,
  readWorkspacePackageManager,
  relativizeInternalSymlinks,
  renderInstallerForChannel,
  resolveNodeVersion,
  resolvePinnedDependenciesFromPnpmList,
  rewriteBinShimBuildRoots,
  sanitizePortableBinShims,
  validateChannelVersion,
  writeDeterministicTarGz,
} from "../../../scripts/portable/build-portable.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let tmpDirs: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  return dir;
}

function currentPlatform(): string | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  if (process.arch !== "x64" && process.arch !== "arm64") return null;
  return `${process.platform}-${process.arch}`;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function commandPath(command: string): string {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `failed to resolve ${command}`);
  return result.stdout.trim();
}

function writeMvWrapper(dir: string): void {
  const wrapper = join(dir, "mv");
  writeFileSync(
    wrapper,
    `#!/bin/sh
set -eu
target=""
saw_flag=0
for arg in "$@"; do
  target="$arg"
  if [ "$arg" = "$FT_TEST_REQUIRED_MV_FLAG" ]; then
    saw_flag=1
  fi
done
if [ "$target" = "$FT_TEST_CURRENT_LINK" ]; then
  current_version="$(cat "$FT_TEST_CURRENT_LINK/VERSION" 2>/dev/null || true)"
  if [ "$current_version" != "$FT_TEST_OLD_VERSION" ]; then
    echo "expected current to remain readable as $FT_TEST_OLD_VERSION before mv, got $current_version" >&2
    exit 41
  fi
  if [ "$saw_flag" != "1" ]; then
    echo "expected current switch to use $FT_TEST_REQUIRED_MV_FLAG" >&2
    exit 42
  fi
  if [ "\${FT_TEST_FAIL_CURRENT_SWITCH:-}" = "1" ]; then
    echo "simulated current switch failure" >&2
    exit 43
  fi
fi
exec "$FT_TEST_REAL_MV" "$@"
`,
    { mode: 0o755 },
  );
}

function writeTarWrapper(dir: string): void {
  const wrapper = join(dir, "tar");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("tar (GNU tar) 1.35\\n");
  process.exit(0);
}

const sawWarning = args.includes("--warning=no-unknown-keyword");
const isExtract = args.includes("-xzf");
if (process.env.FT_TEST_REQUIRE_TAR_WARNING === "1" && isExtract && !sawWarning) {
  process.stderr.write("expected GNU tar extraction to suppress unknown pax keyword warnings\\n");
  process.exit(44);
}

const filteredArgs = args.filter((arg) => arg !== "--warning=no-unknown-keyword");
const res = spawnSync(process.env.FT_TEST_REAL_TAR, filteredArgs, { stdio: "inherit" });
if (res.error) {
  process.stderr.write(String(res.error.message) + "\\n");
  process.exit(1);
}
process.exit(res.status ?? 1);
`,
    { mode: 0o755 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("builds portable archives from a deterministic file list without xattrs or build-user ownership", () => {
    expect(
      portableTarCreateArgs({ tarballPath: "payload.tar", sourceDir: "payload", fileListPath: "files.txt" }),
    ).toEqual([
      "--no-recursion",
      "--no-xattrs",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      "payload.tar",
      "-C",
      "payload",
      "-T",
      "files.txt",
    ]);
    expect(portableTarCreateArgs({ tarballPath: "payload.tar", sourceDir: "payload", tarFlavor: "bsd" })).toEqual([
      "--no-recursion",
      "--no-xattrs",
      "--uid",
      "0",
      "--gid",
      "0",
      "--uname",
      "",
      "--gname",
      "",
      "-cf",
      "payload.tar",
      "-C",
      "payload",
      ".",
    ]);
    expect(() => portableTarCreateArgs({ tarballPath: "p.tar", sourceDir: "p", tarFlavor: "zip" })).toThrow(
      /tar flavor/,
    );
  });

  it("normalizes generatedAt timestamps for release metadata", () => {
    expect(normalizeGeneratedAt("2026-01-01T08:00:00+08:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(() => normalizeGeneratedAt("not-a-date")).toThrow(/valid timestamp/);
  });

  it("uses an exact default Node runtime version from the portable pin file", () => {
    expect(readFileSync(NODE_VERSION_FILE, "utf8").trim()).toBe(DEFAULT_NODE_VERSION);
    expect(DEFAULT_NODE_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(normalizeNodeVersion(DEFAULT_NODE_VERSION.slice(1))).toBe(DEFAULT_NODE_VERSION);
  });

  it("rejects floating Node runtime specs", async () => {
    await expect(resolveNodeVersion("latest-v24.x")).rejects.toThrow(/exact Node.js version/);
  });

  it("writes portable package dependencies with exact locked versions", () => {
    const sourcePackage = {
      description: "First Tree CLI",
      license: "MIT",
      repository: { type: "git", url: "https://example.test/first-tree.git" },
      engines: { node: ">=22.13" },
      dependencies: {
        commander: "^13.1.0",
        zod: "^4.0.0",
      },
    };
    const dependencies = resolvePinnedDependenciesFromPnpmList({
      packageName: "first-tree-dev",
      sourceDependencies: sourcePackage.dependencies,
      listOutput: JSON.stringify([
        {
          name: "first-tree-dev",
          dependencies: {
            commander: { version: "13.1.0" },
            zod: { version: "4.3.6" },
          },
        },
      ]),
    });
    const appPackage = packageJsonForApp({
      channelConfig: {
        packageName: "first-tree",
        binName: "first-tree",
        aliasName: "ft",
      },
      version: "1.2.3",
      dependencies,
      sourcePackage,
      packageManager: "pnpm@10.12.1",
    });

    expect(appPackage.dependencies).toEqual({ commander: "13.1.0", zod: "4.3.6" });
    expect(
      Object.values(appPackage.dependencies).every((version) => !version.startsWith("^") && !version.startsWith("~")),
    ).toBe(true);
    expect(appPackage.packageManager).toBe("pnpm@10.12.1");
  });

  it("pins the temp-dir install to the workspace pnpm version", () => {
    expect(readWorkspacePackageManager({ packageManager: "pnpm@10.12.1" })).toBe("pnpm@10.12.1");
    expect(() => readWorkspacePackageManager({ packageManager: "pnpm@^10" })).toThrow(/exact pnpm version/);
    expect(() => readWorkspacePackageManager({})).toThrow(/exact pnpm version/);
    expect(readWorkspacePackageManager()).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it("fails when a portable dependency is missing from locked pnpm output", () => {
    expect(() =>
      resolvePinnedDependenciesFromPnpmList({
        packageName: "first-tree-dev",
        sourceDependencies: {
          commander: "^13.1.0",
          zod: "^4.0.0",
        },
        listOutput: JSON.stringify([
          {
            name: "first-tree-dev",
            dependencies: {
              commander: { version: "13.1.0" },
            },
          },
        ]),
      }),
    ).toThrow(/zod.*missing/);
  });

  it("rewrites pnpm absolute internal symlinks to portable relative targets", async () => {
    const root = tempDir("first-tree-portable-symlink-");
    await mkdir(join(root, "node_modules", ".pnpm", "zod@4.3.6", "node_modules", "zod"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    const target = join(root, "node_modules", ".pnpm", "zod@4.3.6", "node_modules", "zod");
    const link = join(root, "node_modules", "zod");
    await writeFile(join(target, "index.js"), "export {};\n");
    await symlink(target, link);

    relativizeInternalSymlinks(root);

    expect(readlinkSync(link)).toBe(".pnpm/zod@4.3.6/node_modules/zod");
    expect(readFileSync(join(link, "index.js"), "utf8")).toBe("export {};\n");
  });

  it("generates the portable lockfile without requiring an offline pnpm metadata mirror", () => {
    expect(PORTABLE_LOCKFILE_INSTALL_ARGS).toContain("--lockfile-only");
    expect(PORTABLE_LOCKFILE_INSTALL_ARGS).toContain("--prefer-offline");
    expect(PORTABLE_LOCKFILE_INSTALL_ARGS).not.toContain("--offline");
    expect(PORTABLE_NODE_MODULES_INSTALL_ARGS).toContain("--frozen-lockfile");
    expect(PORTABLE_NODE_MODULES_INSTALL_ARGS).not.toContain("--offline");
  });

  it("orders build roots longest-first and includes the realpath variant", () => {
    const dir = tempDir("first-tree-portable-roots-");
    const roots = portableBuildRoots(dir);
    expect(roots).toContain(realpathSync(dir));
    for (let i = 1; i < roots.length; i += 1) {
      expect(roots[i - 1].length).toBeGreaterThanOrEqual(roots[i].length);
    }
  });

  it("replaces overlapping build root variants without leaving a path prefix behind", () => {
    const rewritten = rewriteBinShimBuildRoots({
      content: 'export NODE_PATH="/private/var/tmp/build/app/node_modules/.pnpm/node_modules"\n',
      shimDir: "/var/tmp/build/app/node_modules/.bin",
      appDir: "/var/tmp/build/app",
      buildRoots: ["/private/var/tmp/build/app", "/var/tmp/build/app"],
    });
    expect(rewritten).toBe('export NODE_PATH="$basedir/../../node_modules/.pnpm/node_modules"\n');
  });

  it("rewrites bin shim build paths to basedir-relative form for reproducible artifacts", async () => {
    const root = tempDir("first-tree-portable-shim-");
    const appDir = join(root, "app");
    const topBin = join(appDir, "node_modules", ".bin");
    const nestedBin = join(
      appDir,
      "node_modules",
      ".pnpm",
      "gray-matter@4.0.3",
      "node_modules",
      "gray-matter",
      "node_modules",
      ".bin",
    );
    await mkdir(topBin, { recursive: true });
    await mkdir(nestedBin, { recursive: true });
    const buildRoot = realpathSync(appDir);
    const shim = (target: string) =>
      `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
export NODE_PATH="${buildRoot}/node_modules/.pnpm/node_modules"
exec node "$basedir/../${target}" "$@"
# cmd-shim-target=${buildRoot}/node_modules/${target}
`;
    writeFileSync(join(topBin, "semver"), shim("semver/bin/semver.js"), { mode: 0o755 });
    writeFileSync(join(nestedBin, "js-yaml"), shim("js-yaml/bin/js-yaml.js"), { mode: 0o755 });

    const rewritten = sanitizePortableBinShims(appDir);

    expect(rewritten).toHaveLength(2);
    const topContent = readFileSync(join(topBin, "semver"), "utf8");
    expect(topContent).toContain('NODE_PATH="$basedir/../../node_modules/.pnpm/node_modules"');
    expect(topContent).not.toContain(buildRoot);
    const nestedContent = readFileSync(join(nestedBin, "js-yaml"), "utf8");
    expect(nestedContent).toContain('NODE_PATH="$basedir/../../../../../../../node_modules/.pnpm/node_modules"');
    expect(nestedContent).not.toContain(buildRoot);
    expect(statSync(join(topBin, "semver")).mode & 0o755).toBe(0o755);
    expect(() => assertNoBuildRootReferences(appDir)).not.toThrow();
  });

  it("fails closed when a portable app file still references its build directory", async () => {
    const root = tempDir("first-tree-portable-leak-");
    const appDir = join(root, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "leak.txt"), `${realpathSync(appDir)}/node_modules\n`);
    expect(() => assertNoBuildRootReferences(appDir)).toThrow(/build directory/);
  });

  it("copies portable app templates without rewriting relative symlinks to the source temp dir", async () => {
    const source = tempDir("first-tree-portable-copy-source-");
    const output = tempDir("first-tree-portable-copy-output-");
    await mkdir(join(source, "node_modules", ".pnpm", "zod@4.3.6", "node_modules", "zod"), { recursive: true });
    const link = join(source, "node_modules", "zod");
    await symlink(".pnpm/zod@4.3.6/node_modules/zod", link);

    copyPortableAppTemplate(source, join(output, "app"));

    expect(readlinkSync(join(output, "app", "node_modules", "zod"))).toBe(".pnpm/zod@4.3.6/node_modules/zod");
  });

  it("rejects portable app symlinks that point outside the app root", async () => {
    const root = tempDir("first-tree-portable-outside-symlink-");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(tmpdir(), join(root, "node_modules", "outside"));

    expect(() => relativizeInternalSymlinks(root)).toThrow(/outside app root/);
  });

  it("writes deterministic portable archive bytes for the same inputs", async () => {
    const source = tempDir("first-tree-portable-archive-source-");
    const output = tempDir("first-tree-portable-archive-output-");
    await mkdir(join(source, "bin"), { recursive: true });
    await mkdir(join(source, "app", "cli"), { recursive: true });
    await writeFile(join(source, "VERSION"), "1.2.3\n");
    await writeFile(join(source, "bin", "first-tree"), "#!/bin/sh\necho first-tree\n", { mode: 0o755 });
    await writeFile(join(source, "app", "cli", "index.mjs"), "console.log('first-tree');\n");

    const generatedAt = "2026-01-01T00:00:00.000Z";
    const first = join(output, "first.tar.gz");
    const second = join(output, "second.tar.gz");
    await writeDeterministicTarGz({ sourceDir: source, tarballPath: first, generatedAt });
    await writeFile(join(source, "app", "cli", "index.mjs"), "console.log('first-tree');\n");
    await writeDeterministicTarGz({ sourceDir: source, tarballPath: second, generatedAt });

    expect(sha256(second)).toBe(sha256(first));
  });

  it("uses the official release download base URL by default", () => {
    expect(DEFAULT_DOWNLOAD_BASE_URL).toBe("https://download.first-tree.ai/releases");
    expect(
      artifactDownloadUrl({
        downloadBaseUrl: DEFAULT_DOWNLOAD_BASE_URL,
        channel: "prod",
        version: "1.2.3",
        fileName: "first-tree-1.2.3-linux-x64.tar.gz",
      }),
    ).toBe("https://download.first-tree.ai/releases/prod/1.2.3/first-tree-1.2.3-linux-x64.tar.gz");
    expect(
      manifestDownloadUrl({
        downloadBaseUrl: DEFAULT_DOWNLOAD_BASE_URL,
        channel: "prod",
        version: "1.2.3",
      }),
    ).toBe("https://download.first-tree.ai/releases/prod/1.2.3/manifest.json");
  });

  it("normalizes custom download base URLs and rejects channel-scoped URLs", () => {
    expect(normalizeDownloadBaseUrl("https://downloads.example.test/releases///")).toBe(
      "https://downloads.example.test/releases",
    );
    expect(() => normalizeDownloadBaseUrl("https://downloads.example.test/releases/prod")).toThrow(
      /must not include the channel segment/,
    );
    expect(() => normalizeDownloadBaseUrl("https://downloads.example.test/releases/staging/")).toThrow(
      /must not include the channel segment/,
    );
  });

  it("writes custom download base URLs into portable metadata", () => {
    const downloadBaseUrl = "https://downloads.example.test/releases";
    const fileName = "first-tree-1.2.3-linux-x64.tar.gz";
    const asset = {
      platform: "linux-x64",
      fileName,
      url: artifactDownloadUrl({ downloadBaseUrl, channel: "prod", version: "1.2.3", fileName }),
      sha256: "a".repeat(64),
      size: 7,
    };
    const { manifest, latest } = buildPortableReleaseMetadata({
      channel: "prod",
      channelConfig: {
        packageName: "first-tree",
        binName: "first-tree",
        aliasName: "ft",
      },
      version: "1.2.3",
      gitSha: "abc123",
      nodeVersion: "v24.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      downloadBaseUrl,
      assets: [asset],
    });

    expect(manifest.assets[0]?.url).toBe(
      "https://downloads.example.test/releases/prod/1.2.3/first-tree-1.2.3-linux-x64.tar.gz",
    );
    expect(latest.manifestUrl).toBe("https://downloads.example.test/releases/prod/1.2.3/manifest.json");
    expect(latest.assets[0]?.url).toBe(manifest.assets[0]?.url);
  });

  it("bakes custom channel installer defaults while preserving runtime download override", () => {
    const installer = renderInstallerForChannel("staging", "https://downloads.example.test/releases/");
    const channelFallback = "$" + "{FIRST_TREE_PORTABLE_CHANNEL:-staging}";
    const customBaseFallback = "$" + "{FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-https://downloads.example.test/releases}";
    const defaultBaseFallback =
      "$" + "{FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-https://download.first-tree.ai/releases}";
    expect(installer).toContain(`PORTABLE_CHANNEL="${channelFallback}"`);
    expect(installer).toContain(`DOWNLOAD_BASE_URL="${customBaseFallback}"`);
    expect(installer).not.toContain(`DOWNLOAD_BASE_URL="${defaultBaseFallback}"`);
  });

  it("renders installer defaults when replacements match the template values", () => {
    const prodInstaller = renderInstallerForChannel("prod", DEFAULT_DOWNLOAD_BASE_URL);
    const prodChannelFallback = "$" + "{FIRST_TREE_PORTABLE_CHANNEL:-prod}";
    const stagingInstaller = renderInstallerForChannel("staging", DEFAULT_DOWNLOAD_BASE_URL);
    const stagingChannelFallback = "$" + "{FIRST_TREE_PORTABLE_CHANNEL:-staging}";
    const downloadBaseFallback =
      "$" + "{FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-https://download.first-tree.ai/releases}";

    expect(prodInstaller).toContain(`PORTABLE_CHANNEL="${prodChannelFallback}"`);
    expect(prodInstaller).toContain(`DOWNLOAD_BASE_URL="${downloadBaseFallback}"`);
    expect(stagingInstaller).toContain(`PORTABLE_CHANNEL="${stagingChannelFallback}"`);
    expect(stagingInstaller).toContain(`DOWNLOAD_BASE_URL="${downloadBaseFallback}"`);
  });
});

describe("portable installer", () => {
  async function writeFixtureVersion(root: string, version: string, platform: string): Promise<void> {
    const channelDir = join(root, "prod");
    const versionDir = join(channelDir, version);
    const payload = join(root, `payload-${version}`);
    await mkdir(join(payload, "node", "bin"), { recursive: true });
    await mkdir(join(payload, "app", "cli"), { recursive: true });
    await mkdir(join(payload, "bin"), { recursive: true });
    await writeFile(
      join(payload, "node", "bin", "node"),
      `#!/bin/sh
if [ -n "\${FT_TEST_NODE_ARGS_LOG:-}" ]; then
  printf '%s\\n' "$*" >>"$FT_TEST_NODE_ARGS_LOG"
fi
if [ "$2" = "--version" ]; then echo ${version}; exit 0; fi
if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi
echo node-stub "$@"
`,
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
        platform,
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
    const tarball = join(versionDir, `first-tree-${version}-${platform}.tar.gz`);
    const tar = spawnSync("tar", ["-czf", tarball, "-C", payload, "."], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(tar.stderr);
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
          platform,
          fileName: `first-tree-${version}-${platform}.tar.gz`,
          url: `file://${tarball}`,
          sha256: sha256(tarball),
          size: statSync(tarball).size,
        },
      ],
    };
    writeFileSync(join(channelDir, "latest.json"), JSON.stringify(latest, null, 2));
    writeFileSync(join(versionDir, "manifest.json"), JSON.stringify({ ...latest, manifestUrl: undefined }, null, 2));
  }

  async function makeFixture(platform: string): Promise<string> {
    const root = tempDir("first-tree-install-test-");
    await writeFixtureVersion(root, "1.2.3", platform);
    return root;
  }

  it("installs from a local manifest and writes portable shims", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
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

  it("prints shell refresh guidance for the profile it updates", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const profile = join(home, ".zshrc");
    const res = spawnSync(
      "sh",
      [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          SHELL: "/bin/zsh",
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
        },
        encoding: "utf8",
      },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(readFileSync(profile, "utf8")).toContain(`export PATH="${binDir}:$PATH"`);
    expect(res.stdout).toContain(`Restart your shell, or run: . "${profile}"`);
    expect(res.stdout).not.toContain("Add this to your shell profile:");
  });

  it("keeps manual PATH guidance when path editing is disabled", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const profile = join(home, ".zshrc");
    const res = spawnSync(
      "sh",
      [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir, "--no-path-edit"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          SHELL: "/bin/zsh",
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
        },
        encoding: "utf8",
      },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(existsSync(profile)).toBe(false);
    expect(res.stdout).not.toContain("Restart your shell, or run: . ");
    expect(res.stdout).toContain(`Add this to your shell profile: export PATH="${binDir}:$PATH"`);
  });

  it("suppresses GNU tar unknown pax keyword warnings during extraction", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const realTar = commandPath("tar");
    const wrapperDir = tempDir("first-tree-tar-wrapper-");
    writeTarWrapper(wrapperDir);
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
          FT_TEST_REAL_TAR: realTar,
          FT_TEST_REQUIRE_TAR_WARNING: "1",
          PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
  });

  it("repairs PATH shadowing, cleans npm temp residue, and invokes daemon service recovery", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const npmBinDir = join(home, "npm-bin");
    const npmRoot = join(home, "npm-root");
    const wrapperDir = join(home, "wrappers");
    const argsLog = join(home, "node-args.log");
    await mkdir(npmBinDir, { recursive: true });
    await mkdir(npmRoot, { recursive: true });
    await mkdir(join(npmRoot, ".first-tree-deadbeef"), { recursive: true });
    await mkdir(wrapperDir, { recursive: true });
    await writeFile(join(npmBinDir, "first-tree"), "#!/bin/sh\necho npm-first-tree\n", { mode: 0o755 });
    await writeFile(
      join(wrapperDir, "npm"),
      '#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "$FT_TEST_NPM_ROOT"; exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    );

    const installArgs = [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir];
    const env = {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      PATH: `${npmBinDir}:${wrapperDir}:${process.env.PATH ?? ""}`,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
      FT_TEST_NODE_ARGS_LOG: argsLog,
      FT_TEST_NPM_ROOT: npmRoot,
    };

    const firstInstall = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(firstInstall.status, firstInstall.stderr || firstInstall.stdout).toBe(0);
    expect(() => readdirSync(join(npmRoot, ".first-tree-deadbeef"))).toThrow();
    const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(zshrc.match(/# >>> first-tree portable >>>/g)).toHaveLength(1);
    expect(zshrc).toContain(`export PATH="${binDir}:$PATH"`);

    const secondInstall = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(secondInstall.status, secondInstall.stderr || secondInstall.stdout).toBe(0);
    const rewrittenZshrc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(rewrittenZshrc.match(/# >>> first-tree portable >>>/g)).toHaveLength(1);

    const nodeArgs = readFileSync(argsLog, "utf8");
    expect(nodeArgs).toContain("app/cli/index.mjs --version");
    expect(nodeArgs).toContain("app/cli/index.mjs daemon ensure-service");
  });

  it("replaces the current symlink itself when upgrading with the shell installer", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
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

    await writeFixtureVersion(fixture, "1.2.4", platform);
    const realMv = commandPath("mv");
    const wrapperDir = tempDir("first-tree-mv-wrapper-");
    writeMvWrapper(wrapperDir);
    const secondInstall = spawnSync("sh", installArgs, {
      cwd: REPO_ROOT,
      env: {
        ...env,
        PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
        FT_TEST_CURRENT_LINK: join(prefix, "current"),
        FT_TEST_FAIL_CURRENT_SWITCH: "0",
        FT_TEST_OLD_VERSION: "1.2.3",
        FT_TEST_REAL_MV: realMv,
        FT_TEST_REQUIRED_MV_FLAG: process.platform === "darwin" ? "-h" : "-T",
      },
      encoding: "utf8",
    });

    expect(secondInstall.status, secondInstall.stderr || secondInstall.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.4\n");
    expect(readdirSync(join(prefix, "versions", "1.2.3")).filter((entry) => entry.startsWith(".current."))).toEqual([]);
  });

  it("leaves the previous current symlink intact when atomic current replacement fails", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
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

    await writeFixtureVersion(fixture, "1.2.4", platform);
    const realMv = commandPath("mv");
    const wrapperDir = tempDir("first-tree-mv-wrapper-");
    writeMvWrapper(wrapperDir);
    const secondInstall = spawnSync("sh", installArgs, {
      cwd: REPO_ROOT,
      env: {
        ...env,
        PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
        FT_TEST_CURRENT_LINK: join(prefix, "current"),
        FT_TEST_FAIL_CURRENT_SWITCH: "1",
        FT_TEST_OLD_VERSION: "1.2.3",
        FT_TEST_REAL_MV: realMv,
        FT_TEST_REQUIRED_MV_FLAG: process.platform === "darwin" ? "-h" : "-T",
      },
      encoding: "utf8",
    });

    expect(secondInstall.status).not.toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
    expect(readdirSync(prefix).filter((entry) => entry.startsWith(".current."))).toEqual([]);
    expect(readdirSync(join(prefix, "versions", "1.2.3")).filter((entry) => entry.startsWith(".current."))).toEqual([]);
  });

  it("leaves the previous current symlink intact on checksum failure", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
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
