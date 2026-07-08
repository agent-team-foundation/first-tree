import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactDownloadUrl,
  artifactFileName,
  buildPortableReleaseMetadata,
  copyPortableAppTemplate,
  DEFAULT_DOWNLOAD_BASE_URL,
  DEFAULT_NODE_VERSION,
  manifestDownloadUrl,
  NODE_VERSION_FILE,
  normalizeDownloadBaseUrl,
  normalizeGeneratedAt,
  normalizeNodeVersion,
  packageJsonForApp,
  parsePlatform,
  portableTarCreateArgs,
  relativizeInternalSymlinks,
  renderInstallerForChannel,
  resolveNodeVersion,
  resolvePinnedDependenciesFromPnpmList,
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

  it("builds portable archives from a deterministic file list without platform xattrs", () => {
    expect(
      portableTarCreateArgs({ tarballPath: "payload.tar", sourceDir: "payload", fileListPath: "files.txt" }),
    ).toEqual(["--no-recursion", "--no-xattrs", "-cf", "payload.tar", "-C", "payload", "-T", "files.txt"]);
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
    });

    expect(appPackage.dependencies).toEqual({ commander: "13.1.0", zod: "4.3.6" });
    expect(
      Object.values(appPackage.dependencies).every((version) => !version.startsWith("^") && !version.startsWith("~")),
    ).toBe(true);
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
