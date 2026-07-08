#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const CLI_ROOT = join(REPO_ROOT, "apps", "cli");
const SHARED_CHANNEL_DIST = join(REPO_ROOT, "packages", "shared", "dist", "channel", "index.mjs");
const EXACT_NODE_VERSION_RE = /^v?\d+\.\d+\.\d+$/;
const EXACT_PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const PORTABLE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
export const DEFAULT_DOWNLOAD_BASE_URL = "https://download.first-tree.ai/releases";
export const NODE_VERSION_FILE = join(SCRIPT_DIR, "node-version.txt");

function normalizeExactNodeVersionString(version) {
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  if (!EXACT_NODE_VERSION_RE.test(trimmed)) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function readDefaultNodeVersion() {
  const value = readFileSync(NODE_VERSION_FILE, "utf8").trim();
  const normalized = normalizeExactNodeVersionString(value);
  if (!normalized) {
    throw new Error(`scripts/portable/node-version.txt must contain an exact Node.js version like v24.18.0`);
  }
  return normalized;
}

export const DEFAULT_NODE_VERSION = readDefaultNodeVersion();

const CHANNEL_FALLBACKS = {
  prod: {
    channel: "prod",
    binName: "first-tree",
    aliasName: "ft",
    packageName: "first-tree",
    portable: { channelPrefix: "prod", publicInstallerPath: "prod/install.sh" },
  },
  staging: {
    channel: "staging",
    binName: "first-tree-staging",
    aliasName: "fts",
    packageName: "first-tree-staging",
    portable: { channelPrefix: "staging", publicInstallerPath: "staging/install.sh" },
  },
};

function fail(message) {
  throw new Error(message);
}

export function validateChannelVersion(channel, version) {
  if (channel === "prod") {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      fail(`prod portable builds require a stable X.Y.Z semver version, got ${version}`);
    }
    return;
  }
  if (channel === "staging") {
    if (!/^\d+\.\d+\.\d+-staging\.[0-9A-Za-z.-]+$/.test(version)) {
      fail(`staging portable builds require a -staging. prerelease version, got ${version}`);
    }
    return;
  }
  fail(`unsupported portable channel: ${channel}`);
}

export function parsePlatform(platform) {
  if (!PORTABLE_PLATFORMS.includes(platform)) fail(`unsupported portable platform: ${platform}`);
  const [os, arch] = platform.split("-");
  return { os, arch };
}

export function artifactFileName(options) {
  return `${options.packageName}-${options.version}-${options.platform}.tar.gz`;
}

// Tar headers must not record the build machine's uid/gid/user names: they
// would make byte-reproducibility depend on which user ran the build, and the
// flag spelling differs between GNU tar (CI runners) and bsdtar (macOS).
export function tarOwnershipArgs(tarFlavor) {
  if (tarFlavor === "gnu") return ["--owner=0", "--group=0", "--numeric-owner"];
  if (tarFlavor === "bsd") return ["--uid", "0", "--gid", "0", "--uname", "", "--gname", ""];
  fail(`unsupported tar flavor: ${tarFlavor}`);
}

export function detectTarFlavor() {
  const res = run("tar", ["--version"], { stdio: "pipe" });
  return res.stdout.includes("GNU tar") ? "gnu" : "bsd";
}

export function portableTarCreateArgs({ tarballPath, sourceDir, fileListPath = null, tarFlavor = "gnu" }) {
  const args = ["--no-recursion", "--no-xattrs", ...tarOwnershipArgs(tarFlavor), "-cf", tarballPath, "-C", sourceDir];
  if (fileListPath) args.push("-T", fileListPath);
  else args.push(".");
  return args;
}

export function normalizeDownloadBaseUrl(value) {
  const trimmed = value.replace(/\/+$/, "");
  if (!trimmed) fail("--download-base-url is required");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail(`--download-base-url must be a valid URL, got ${value}`);
  }
  const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (lastSegment === "prod" || lastSegment === "staging") {
    fail(`--download-base-url must not include the channel segment; got ${value}`);
  }
  return trimmed;
}

export function artifactDownloadUrl(options) {
  return `${normalizeDownloadBaseUrl(options.downloadBaseUrl)}/${options.channel}/${options.version}/${options.fileName}`;
}

export function manifestDownloadUrl(options) {
  return `${normalizeDownloadBaseUrl(options.downloadBaseUrl)}/${options.channel}/${options.version}/manifest.json`;
}

function parseArgs(argv) {
  const options = {
    channel: null,
    version: null,
    gitSha: null,
    nodeVersion: DEFAULT_NODE_VERSION,
    downloadBaseUrl: DEFAULT_DOWNLOAD_BASE_URL,
    generatedAt: null,
    outDir: null,
    platforms: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--channel") options.channel = next();
    else if (arg === "--version") options.version = next();
    else if (arg === "--git-sha") options.gitSha = next();
    else if (arg === "--node-version") options.nodeVersion = next();
    else if (arg === "--download-base-url") options.downloadBaseUrl = next();
    else if (arg === "--generated-at") options.generatedAt = next();
    else if (arg === "--out-dir") options.outDir = next();
    else if (arg === "--platform") options.platforms.push(next());
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (options.channel !== "prod" && options.channel !== "staging") fail("--channel must be prod or staging");
  if (!options.version) fail("--version is required");
  if (!options.gitSha) fail("--git-sha is required");
  if (!options.outDir) fail("--out-dir is required");
  options.platforms = options.platforms.length > 0 ? options.platforms : [...PORTABLE_PLATFORMS];
  for (const platform of options.platforms) parsePlatform(platform);
  validateChannelVersion(options.channel, options.version);
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/portable/build-portable.mjs --channel prod|staging --version <semver> --git-sha <sha> --out-dir <path> [options]

Options:
  --node-version <version>          Exact Node.js version (vX.Y.Z or X.Y.Z). Defaults to scripts/portable/node-version.txt (${DEFAULT_NODE_VERSION})
  --download-base-url <url>         Public artifact base URL (default: ${DEFAULT_DOWNLOAD_BASE_URL})
  --generated-at <timestamp>        Release generation timestamp. Defaults to the current time.
  --platform <platform>             Repeatable: ${PORTABLE_PLATFORMS.join(", ")}
  --help                            Show this help

The script expects apps/cli/dist to already exist. It does not run a build.`);
}

async function loadChannelConfig(channel) {
  if (existsSync(SHARED_CHANNEL_DIST)) {
    const mod = await import(pathToFileURL(SHARED_CHANNEL_DIST).href);
    return mod.getChannelConfig(channel);
  }
  return CHANNEL_FALLBACKS[channel];
}

function assertInputBuildExists() {
  const required = [
    join(CLI_ROOT, "dist", "cli", "index.mjs"),
    join(CLI_ROOT, "dist", "index.mjs"),
    join(CLI_ROOT, "package.json"),
    join(REPO_ROOT, "skills", "first-tree-write", "SKILL.md"),
    join(CLI_ROOT, "README.md"),
    join(CLI_ROOT, "LICENSE"),
  ];
  const missing = required.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    fail(`portable build inputs are missing; run pnpm --filter first-tree-dev build first:\n${missing.join("\n")}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    stdio: options.stdio ?? "inherit",
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
  if (res.error) fail(`${command} failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed with exit ${res.status}${detail ? `\n${detail}` : ""}`);
  }
  return res;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}

export function normalizeGeneratedAt(value) {
  if (typeof value !== "string" || value.trim() === "") fail("--generated-at requires a timestamp value");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(`--generated-at must be a valid timestamp, got ${value}`);
  return date.toISOString();
}

async function listArchiveEntries(root, relativeDir = "") {
  const entries = await readdir(join(root, relativeDir), { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const paths = [];
  for (const name of names) {
    const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
    const fullPath = join(root, relativePath);
    const stat = lstatSync(fullPath);
    paths.push(`./${relativePath}`);
    if (stat.isDirectory()) {
      paths.push(...(await listArchiveEntries(root, relativePath)));
    }
  }
  return paths;
}

async function normalizeArchiveTimes(path, timestamp) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      await normalizeArchiveTimes(join(path, entry.name), timestamp);
    }
  }
  if (stat.isSymbolicLink()) {
    lutimesSync(path, timestamp, timestamp);
  } else {
    utimesSync(path, timestamp, timestamp);
  }
}

export async function writeDeterministicTarGz({ sourceDir, tarballPath, generatedAt }) {
  const normalizedGeneratedAt = normalizeGeneratedAt(generatedAt);
  const timestamp = new Date(normalizedGeneratedAt);
  await normalizeArchiveTimes(sourceDir, timestamp);

  const tempDir = await mkdtemp(join(tmpdir(), "first-tree-portable-tar-"));
  try {
    const fileListPath = join(tempDir, "files.txt");
    const tarPath = join(tempDir, "payload.tar");
    const entries = [".", ...(await listArchiveEntries(sourceDir))];
    writeFileSync(fileListPath, `${entries.join("\n")}\n`);
    run("tar", portableTarCreateArgs({ tarballPath: tarPath, sourceDir, fileListPath, tarFlavor: detectTarFlavor() }), {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    writeFileSync(tarballPath, gzipSync(readFileSync(tarPath), { mtime: 0 }));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function readSourceTreeChannel(source = readFileSync(join(CLI_ROOT, "src", "build-info.ts"), "utf8")) {
  const match = source.match(/export const CHANNEL(?::\s*ChannelName)?\s*=\s*["'](dev|staging|prod)["'];/);
  return match?.[1] ?? null;
}

export function rewriteBundleChannelText(source, channel) {
  const rewrites = [
    {
      re: /\b(const\s+channelConfig\s*=\s*getChannelConfig\()\s*["'](?:dev|staging|prod)["'](\s*\)\s*;)/g,
      replace: (_match, prefix, suffix) => `${prefix}"${channel}"${suffix}`,
    },
    {
      re: /\b((?:const|let|var)\s+CHANNEL\s*=\s*)["'](?:dev|staging|prod)["'](\s*;)/g,
      replace: (_match, prefix, suffix) => `${prefix}"${channel}"${suffix}`,
    },
  ];

  let content = source;
  let replacements = 0;
  for (const rewrite of rewrites) {
    content = content.replace(rewrite.re, (...args) => {
      replacements += 1;
      return rewrite.replace(...args);
    });
  }

  return { content, replacements };
}

export async function rewriteBundleChannel(appDir, channel, options = {}) {
  const files = (await listFiles(appDir)).filter((path) => path.endsWith(".mjs"));
  let replacements = 0;
  for (const file of files) {
    const before = await readFile(file, "utf8");
    const rewritten = rewriteBundleChannelText(before, channel);
    replacements += rewritten.replacements;
    if (rewritten.replacements > 0) await writeFile(file, rewritten.content, "utf8");
  }
  if (replacements === 1) return;

  const sourceChannel = options.sourceChannel ?? readSourceTreeChannel();
  if (replacements === 0 && sourceChannel === channel) {
    return;
  }
  fail(`expected to rewrite exactly one bundled channel constant, rewrote ${replacements}`);
}

function copyPruneScripts(appDir) {
  const dest = join(appDir, "scripts");
  mkdirSync(dest, { recursive: true });
  for (const name of [
    "prune-codex-runtime-binary.mjs",
    "prune-claude-runtime-binary.mjs",
    "prune-claude-sdk-deps.mjs",
  ]) {
    cpSync(join(CLI_ROOT, "scripts", name), join(dest, name));
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolvePinnedDependenciesFromPnpmList({ packageName, sourceDependencies, listOutput }) {
  let parsed;
  try {
    parsed = JSON.parse(listOutput);
  } catch (err) {
    fail(`failed to parse pnpm list output for ${packageName}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) fail(`pnpm list output for ${packageName} must be a JSON array`);
  const project = parsed.find((item) => isRecord(item) && item.name === packageName);
  if (!isRecord(project)) {
    fail(`pnpm list did not return package ${packageName}; run pnpm install --frozen-lockfile first`);
  }
  const listedDependencies = isRecord(project.dependencies) ? project.dependencies : {};
  const pinned = {};
  for (const depName of Object.keys(sourceDependencies ?? {})) {
    const entry = listedDependencies[depName];
    if (!isRecord(entry) || typeof entry.version !== "string") {
      fail(`portable dependency ${depName} is missing from locked pnpm output for ${packageName}`);
    }
    if (!EXACT_PACKAGE_VERSION_RE.test(entry.version)) {
      fail(`portable dependency ${depName} resolved to non-exact version ${entry.version}`);
    }
    pinned[depName] = entry.version;
  }
  return pinned;
}

export function resolvePinnedAppDependencies(sourcePackage = readJson(join(CLI_ROOT, "package.json"))) {
  if (!sourcePackage.name) fail("apps/cli/package.json must have a package name");
  const sourceDependencies = isRecord(sourcePackage.dependencies) ? sourcePackage.dependencies : {};
  const res = run("pnpm", ["list", "--filter", sourcePackage.name, "--prod", "--json", "--depth", "0"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  return resolvePinnedDependenciesFromPnpmList({
    packageName: sourcePackage.name,
    sourceDependencies,
    listOutput: res.stdout,
  });
}

// The portable app is installed in a temp dir outside the workspace, where the
// root package.json's packageManager pin does not apply, so a bare `pnpm` on
// PATH could be any version. pnpm generations differ in node_modules layout and
// cmd-shim output, which would change shipped bytes between environments, so
// the release build must run under the workspace-pinned pnpm everywhere.
export function readWorkspacePackageManager(rootPackage = readJson(join(REPO_ROOT, "package.json"))) {
  const value = rootPackage.packageManager;
  if (typeof value !== "string" || !/^pnpm@\d+\.\d+\.\d+$/.test(value)) {
    fail("root package.json must pin packageManager to an exact pnpm version for reproducible portable builds");
  }
  return value;
}

export function packageJsonForApp({
  channelConfig,
  version,
  dependencies,
  sourcePackage = readJson(join(CLI_ROOT, "package.json")),
  packageManager = null,
}) {
  return {
    name: channelConfig.packageName,
    version,
    type: "module",
    description: sourcePackage.description,
    license: sourcePackage.license,
    repository: sourcePackage.repository,
    engines: sourcePackage.engines,
    ...(packageManager ? { packageManager } : {}),
    bin: {
      [channelConfig.binName]: "./cli/index.mjs",
      [channelConfig.aliasName]: "./cli/index.mjs",
    },
    dependencies,
  };
}

function cleanupPnpmInstallMetadata(appDir) {
  for (const path of [
    join(appDir, "pnpm-lock.yaml"),
    join(appDir, "node_modules", ".modules.yaml"),
    join(appDir, "node_modules", ".pnpm-workspace-state.json"),
    join(appDir, "node_modules", ".pnpm-workspace-state-v1.json"),
    join(appDir, "node_modules", ".pnpm", "lock.yaml"),
  ]) {
    rmSync(path, { force: true });
  }
}

function isPathInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function relativizeInternalSymlinks(root, dir = root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(path);
      const absoluteTarget = resolve(dirname(path), target);
      if (!isPathInside(root, absoluteTarget)) {
        fail(`portable app contains symlink outside app root: ${path} -> ${target}`);
      }
      const relativeTarget = relative(dirname(path), absoluteTarget) || ".";
      if (relativeTarget !== target) {
        unlinkSync(path);
        symlinkSync(relativeTarget, path);
      }
    } else if (entry.isDirectory()) {
      relativizeInternalSymlinks(root, path);
    }
  }
}

export function copyPortableAppTemplate(sourceDir, destDir) {
  cpSync(sourceDir, destDir, { recursive: true, verbatimSymlinks: true });
}

// The portable app is assembled in a fresh mkdtemp directory, and pnpm's
// cmd-shim bin scripts embed that absolute directory (NODE_PATH exports and
// the cmd-shim-target trailer). Shipping those bytes makes every build of the
// same channel/version differ, which breaks the immutable-object retry
// contract in upload-s3.sh: a release-resume rerun would produce different
// tarball bytes and fail closed. The shims already define `basedir` (their own
// directory) for the exec lines, so the embedded absolute build paths are
// rewritten to $basedir-relative equivalents, which are also the only form
// that is correct on the machine the artifact is finally installed on.
export function portableBuildRoots(appDir) {
  // Longest first: on macOS the raw mkdtemp path (/var/...) is a substring of
  // its realpath (/private/var/...), and replacing the shorter one first would
  // leave a stray "/private" prefix behind.
  return [...new Set([appDir, realpathSync(appDir)])].sort((a, b) => b.length - a.length);
}

function collectBinShimFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === ".bin") {
      for (const shim of readdirSync(path, { withFileTypes: true })) {
        if (shim.isFile()) results.push(join(path, shim.name));
      }
    } else {
      collectBinShimFiles(path, results);
    }
  }
  return results;
}

export function rewriteBinShimBuildRoots({ content, shimDir, appDir, buildRoots }) {
  const rel = relative(shimDir, appDir);
  const replacement = rel === "" ? "$basedir" : `$basedir/${rel}`;
  let result = content;
  for (const root of buildRoots) {
    result = result.split(root).join(replacement);
  }
  return result;
}

export function sanitizePortableBinShims(appDir, buildRoots = portableBuildRoots(appDir)) {
  const rewritten = [];
  for (const shim of collectBinShimFiles(appDir)) {
    const original = readFileSync(shim, "utf8");
    const updated = rewriteBinShimBuildRoots({ content: original, shimDir: dirname(shim), appDir, buildRoots });
    if (updated === original) continue;
    const { mode } = statSync(shim);
    // Recreate instead of writing in place so a hardlinked shim can never
    // mutate a shared pnpm store entry.
    unlinkSync(shim);
    writeFileSync(shim, updated, { mode });
    rewritten.push(shim);
  }
  return rewritten;
}

export function assertNoBuildRootReferences(appDir, buildRoots = portableBuildRoots(appDir)) {
  const rootBuffers = buildRoots.map((root) => Buffer.from(root));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (buildRoots.some((root) => target.includes(root))) offenders.push(relative(appDir, path));
      } else if (entry.isFile()) {
        const content = readFileSync(path);
        if (rootBuffers.some((root) => content.includes(root))) offenders.push(relative(appDir, path));
      }
    }
  };
  walk(appDir);
  if (offenders.length > 0) {
    fail(
      `portable app still references its build directory, which breaks byte-reproducible release retries:\n${offenders.join("\n")}`,
    );
  }
}

// Step 1: regenerate a single-package lockfile for the synthetic portable app.
//
// The portable app's package.json pins every dependency to the exact version
// already resolved in the workspace (see resolvePinnedAppDependencies), and we
// copy the workspace pnpm-lock.yaml so pnpm reuses those locked resolutions
// instead of re-resolving semver ranges.
//
// We intentionally use `--prefer-offline` rather than a bare `--offline`. A
// release/publish runner only ever ran `pnpm install --frozen-lockfile`, which
// populates the content-addressable store but NOT the metadata mirror. A bare
// `--offline` therefore fails closed with ERR_PNPM_NO_OFFLINE_META even though
// every needed version is already pinned, which strands portable publication on
// a fresh CI runner (the release-resume path). `--prefer-offline` reuses the
// metadata mirror when present and otherwise fetches the (immutable) metadata of
// the already-pinned exact versions from the registry. Because the resolution is
// fully determined by the pinned versions and the copied workspace lockfile, the
// generated lockfile — and thus the shipped bytes — is identical regardless of
// whether the metadata came from the mirror or the network.
export const PORTABLE_LOCKFILE_INSTALL_ARGS = [
  "install",
  "--lockfile-only",
  "--prod",
  "--ignore-scripts",
  "--no-optional",
  "--prefer-offline",
  "--no-frozen-lockfile",
];

// Step 2: materialize node_modules strictly from the lockfile generated above.
// This is the step that determines the shipped bytes, and `--frozen-lockfile`
// guarantees it matches that lockfile exactly with no further resolution.
export const PORTABLE_NODE_MODULES_INSTALL_ARGS = [
  "install",
  "--prod",
  "--ignore-scripts",
  "--no-optional",
  "--frozen-lockfile",
];

async function prepareAppTemplate({ channel, channelConfig, version }) {
  const root = await mkdtemp(join(tmpdir(), "first-tree-portable-app-"));
  const appDir = join(root, "app");
  const sourcePackage = readJson(join(CLI_ROOT, "package.json"));
  const dependencies = resolvePinnedAppDependencies(sourcePackage);
  const packageManager = readWorkspacePackageManager();
  cpSync(join(CLI_ROOT, "dist"), appDir, { recursive: true });
  await rewriteBundleChannel(appDir, channel);
  cpSync(join(REPO_ROOT, "skills"), join(appDir, "skills"), { recursive: true });
  cpSync(join(CLI_ROOT, "README.md"), join(appDir, "README.md"));
  cpSync(join(CLI_ROOT, "LICENSE"), join(appDir, "LICENSE"));
  copyPruneScripts(appDir);
  writeJson(
    join(appDir, "package.json"),
    packageJsonForApp({ channelConfig, version, dependencies, sourcePackage, packageManager }),
  );
  cpSync(join(REPO_ROOT, "pnpm-lock.yaml"), join(appDir, "pnpm-lock.yaml"));

  run("pnpm", PORTABLE_LOCKFILE_INSTALL_ARGS, { cwd: appDir });
  run("pnpm", PORTABLE_NODE_MODULES_INSTALL_ARGS, { cwd: appDir });
  for (const script of [
    "scripts/prune-codex-runtime-binary.mjs",
    "scripts/prune-claude-runtime-binary.mjs",
    "scripts/prune-claude-sdk-deps.mjs",
  ]) {
    run(process.execPath, [script], {
      cwd: appDir,
      env: { ...process.env, npm_config_global: "true" },
    });
  }
  relativizeInternalSymlinks(appDir);
  cleanupPnpmInstallMetadata(appDir);
  const buildRoots = portableBuildRoots(appDir);
  sanitizePortableBinShims(appDir, buildRoots);
  assertNoBuildRootReferences(appDir, buildRoots);
  return { root, appDir };
}

export function normalizeNodeVersion(version) {
  const normalized = normalizeExactNodeVersionString(version);
  if (normalized) return normalized;
  fail(
    `portable release builds require an exact Node.js version (vX.Y.Z or X.Y.Z), got ${version}. Use scripts/portable/node-version.txt or --node-version vX.Y.Z.`,
  );
}

async function downloadText(url) {
  const res = await fetch(url);
  if (!res.ok) fail(`failed to download ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) fail(`failed to download ${url}: ${res.status} ${res.statusText}`);
  const body = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, body);
}

export async function resolveNodeVersion(versionSpec) {
  return normalizeNodeVersion(versionSpec);
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function downloadNodeRuntime({ nodeVersion, platform, destDir, cacheDir }) {
  const fileName = `node-${nodeVersion}-${platform}.tar.gz`;
  const distBase = `https://nodejs.org/dist/${nodeVersion}`;
  const shasums = await downloadText(`${distBase}/SHASUMS256.txt`);
  const expected = shasums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === fileName)?.[0];
  if (!expected) fail(`official SHASUMS256.txt did not list ${fileName}`);

  const tarball = join(cacheDir, fileName);
  if (!existsSync(tarball)) {
    await downloadFile(`${distBase}/${fileName}`, tarball);
  }
  const actual = sha256File(tarball);
  if (actual !== expected)
    fail(`Node.js tarball checksum mismatch for ${fileName}: expected ${expected}, got ${actual}`);

  const extractDir = await mkdtemp(join(tmpdir(), "first-tree-node-"));
  try {
    run("tar", ["-xzf", tarball, "-C", extractDir]);
    const extractedRoot = join(extractDir, fileName.replace(/\.tar\.gz$/, ""));
    const nodeSrc = join(extractedRoot, "bin", "node");
    if (!existsSync(nodeSrc)) fail(`Node.js tarball did not contain bin/node: ${fileName}`);
    mkdirSync(join(destDir, "bin"), { recursive: true });
    cpSync(nodeSrc, join(destDir, "bin", "node"));
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

function writeArtifactShim(path, appEntry) {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
export FIRST_TREE_INSTALL_MODE=portable
export FIRST_TREE_PORTABLE_ROOT="$root"
exec "$root/node/bin/node" "$root/${appEntry}" "$@"
`,
    { mode: 0o755 },
  );
}

function buildMetadata({ channel, channelConfig, version, gitSha, nodeVersion, generatedAt }) {
  return {
    schemaVersion: 1,
    channel,
    version,
    gitSha,
    nodeVersion,
    packageName: channelConfig.packageName,
    binName: channelConfig.binName,
    aliasName: channelConfig.aliasName,
    generatedAt,
  };
}

export function buildPortableReleaseMetadata(options) {
  const metadata = buildMetadata(options);
  const manifestUrl = manifestDownloadUrl({
    downloadBaseUrl: options.downloadBaseUrl,
    channel: options.channel,
    version: options.version,
  });
  return {
    manifest: { ...metadata, assets: options.assets },
    latest: { ...metadata, manifestUrl, assets: options.assets },
  };
}

async function buildPlatformArtifact(options) {
  const artifactRoot = await mkdtemp(join(tmpdir(), "first-tree-portable-root-"));
  try {
    const appEntry = "app/cli/index.mjs";
    copyPortableAppTemplate(options.appTemplateDir, join(artifactRoot, "app"));
    await downloadNodeRuntime({
      nodeVersion: options.nodeVersion,
      platform: options.platform,
      destDir: join(artifactRoot, "node"),
      cacheDir: options.nodeCacheDir,
    });
    mkdirSync(join(artifactRoot, "bin"), { recursive: true });
    writeArtifactShim(join(artifactRoot, "bin", options.channelConfig.binName), appEntry);
    writeArtifactShim(join(artifactRoot, "bin", options.channelConfig.aliasName), appEntry);
    writeFileSync(join(artifactRoot, "VERSION"), `${options.version}\n`);
    writeJson(join(artifactRoot, "INSTALL.json"), {
      ...buildMetadata(options),
      platform: options.platform,
      installMode: "portable",
      appEntry,
    });

    const fileName = artifactFileName({
      packageName: options.channelConfig.packageName,
      version: options.version,
      platform: options.platform,
    });
    const tarballPath = join(options.versionDir, fileName);
    await writeDeterministicTarGz({
      sourceDir: artifactRoot,
      tarballPath,
      generatedAt: options.generatedAt,
    });
    return {
      platform: options.platform,
      fileName,
      url: artifactDownloadUrl({
        downloadBaseUrl: options.baseUrl,
        channel: options.channel,
        version: options.version,
        fileName,
      }),
      sha256: sha256File(tarballPath),
      size: statSync(tarballPath).size,
    };
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
}

export function renderInstallerForChannel(channel, downloadBaseUrl = DEFAULT_DOWNLOAD_BASE_URL) {
  const source = readFileSync(join(SCRIPT_DIR, "install.sh"), "utf8");
  const channelPattern = /PORTABLE_CHANNEL="\$\{FIRST_TREE_PORTABLE_CHANNEL:-[^}]+\}"/;
  if (!channelPattern.test(source)) fail("installer template is missing the portable channel fallback");
  const withChannel = source.replace(
    channelPattern,
    () => `PORTABLE_CHANNEL="\${FIRST_TREE_PORTABLE_CHANNEL:-${channel}}"`,
  );

  const normalizedDownloadBaseUrl = normalizeDownloadBaseUrl(downloadBaseUrl);
  const downloadBaseUrlPattern = /DOWNLOAD_BASE_URL="\$\{FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-[^}]*\}"/;
  if (!downloadBaseUrlPattern.test(withChannel)) {
    fail("installer template is missing the portable download base URL fallback");
  }
  return withChannel.replace(
    downloadBaseUrlPattern,
    () => `DOWNLOAD_BASE_URL="\${FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-${normalizedDownloadBaseUrl}}"`,
  );
}

export async function buildPortableDistribution(rawOptions) {
  const options = {
    ...rawOptions,
    outDir: resolve(rawOptions.outDir),
    downloadBaseUrl: normalizeDownloadBaseUrl(rawOptions.downloadBaseUrl),
  };
  validateChannelVersion(options.channel, options.version);
  assertInputBuildExists();

  const channelConfig = await loadChannelConfig(options.channel);
  if (!channelConfig.packageName) fail(`portable builds require a published package channel, got ${options.channel}`);
  const nodeVersion = await resolveNodeVersion(options.nodeVersion);
  const generatedAt = normalizeGeneratedAt(options.generatedAt ?? new Date().toISOString());
  const channelDir = join(options.outDir, options.channel);
  const versionDir = join(channelDir, options.version);
  rmSync(versionDir, { recursive: true, force: true });
  mkdirSync(versionDir, { recursive: true });
  mkdirSync(channelDir, { recursive: true });

  const appTemplate = await prepareAppTemplate({ channel: options.channel, channelConfig, version: options.version });
  const nodeCacheDir = process.env.FIRST_TREE_PORTABLE_NODE_TARBALL_DIR
    ? resolve(process.env.FIRST_TREE_PORTABLE_NODE_TARBALL_DIR)
    : join(options.outDir, ".cache", "node");
  mkdirSync(nodeCacheDir, { recursive: true });

  try {
    const assets = [];
    for (const platform of options.platforms) {
      console.log(`[portable] building ${options.channel} ${options.version} ${platform} with Node ${nodeVersion}`);
      assets.push(
        await buildPlatformArtifact({
          channel: options.channel,
          channelConfig,
          version: options.version,
          gitSha: options.gitSha,
          nodeVersion,
          generatedAt,
          platform,
          appTemplateDir: appTemplate.appDir,
          versionDir,
          baseUrl: options.downloadBaseUrl,
          nodeCacheDir,
        }),
      );
    }

    const { manifest, latest } = buildPortableReleaseMetadata({
      channel: options.channel,
      channelConfig,
      version: options.version,
      gitSha: options.gitSha,
      nodeVersion,
      generatedAt,
      downloadBaseUrl: options.downloadBaseUrl,
      assets,
    });
    writeJson(join(versionDir, "manifest.json"), manifest);
    writeJson(join(channelDir, "latest.json"), latest);
    writeFileSync(
      join(versionDir, "SHA256SUMS"),
      `${assets.map((asset) => `${asset.sha256}  ${asset.fileName}`).join("\n")}\n`,
    );
    writeFileSync(join(channelDir, "install.sh"), renderInstallerForChannel(options.channel, options.downloadBaseUrl), {
      mode: 0o755,
    });

    console.log(`[portable] wrote ${relative(REPO_ROOT, channelDir)}`);
    return { channelDir, versionDir, manifest, latest };
  } finally {
    await rm(appTemplate.root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await buildPortableDistribution(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[portable] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
