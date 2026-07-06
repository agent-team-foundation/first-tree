#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PORTABLE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
export const DEFAULT_NODE_VERSION = "latest-v24.x";
export const DEFAULT_DOWNLOAD_BASE_URL = "https://downloads.first-tree.ai";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const CLI_ROOT = join(REPO_ROOT, "apps", "cli");
const SHARED_CHANNEL_DIST = join(REPO_ROOT, "packages", "shared", "dist", "channel", "index.mjs");

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

function parseArgs(argv) {
  const options = {
    channel: null,
    version: null,
    gitSha: null,
    nodeVersion: DEFAULT_NODE_VERSION,
    downloadBaseUrl: DEFAULT_DOWNLOAD_BASE_URL,
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
  --node-version <version>          Node.js version or latest-v24.x (default: ${DEFAULT_NODE_VERSION})
  --download-base-url <url>         Public artifact base URL (default: ${DEFAULT_DOWNLOAD_BASE_URL})
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

async function rewriteBundleChannel(appDir, channel) {
  const files = (await listFiles(appDir)).filter((path) => path.endsWith(".mjs"));
  const re = /const channelConfig = getChannelConfig\("(dev|staging|prod)"\);/g;
  let replacements = 0;
  for (const file of files) {
    const before = await readFile(file, "utf8");
    const matches = [...before.matchAll(re)];
    if (matches.length === 0) continue;
    const after = before.replace(re, () => {
      replacements += 1;
      return `const channelConfig = getChannelConfig("${channel}");`;
    });
    await writeFile(file, after, "utf8");
  }
  if (replacements !== 1) {
    fail(`expected to rewrite exactly one bundled channel constant, rewrote ${replacements}`);
  }
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

function packageJsonForApp({ channelConfig, version }) {
  const source = readJson(join(CLI_ROOT, "package.json"));
  return {
    name: channelConfig.packageName,
    version,
    type: "module",
    description: source.description,
    license: source.license,
    repository: source.repository,
    engines: source.engines,
    bin: {
      [channelConfig.binName]: "./cli/index.mjs",
      [channelConfig.aliasName]: "./cli/index.mjs",
    },
    dependencies: source.dependencies,
  };
}

async function prepareAppTemplate({ channel, channelConfig, version }) {
  const root = await mkdtemp(join(tmpdir(), "first-tree-portable-app-"));
  const appDir = join(root, "app");
  cpSync(join(CLI_ROOT, "dist"), appDir, { recursive: true });
  await rewriteBundleChannel(appDir, channel);
  cpSync(join(REPO_ROOT, "skills"), join(appDir, "skills"), { recursive: true });
  cpSync(join(CLI_ROOT, "README.md"), join(appDir, "README.md"));
  cpSync(join(CLI_ROOT, "LICENSE"), join(appDir, "LICENSE"));
  copyPruneScripts(appDir);
  writeJson(join(appDir, "package.json"), packageJsonForApp({ channelConfig, version }));

  run(
    "npm",
    [
      "install",
      "--omit=dev",
      "--omit=optional",
      "--ignore-scripts",
      "--package-lock=false",
      "--fund=false",
      "--audit=false",
    ],
    {
      cwd: appDir,
    },
  );
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
  return { root, appDir };
}

function normalizeNodeVersion(version) {
  if (/^v\d+\.\d+\.\d+$/.test(version)) return version;
  if (/^\d+\.\d+\.\d+$/.test(version)) return `v${version}`;
  fail(`unsupported Node.js version string: ${version}`);
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

async function resolveNodeVersion(versionSpec) {
  if (versionSpec === "latest-v24.x") {
    const index = JSON.parse(await downloadText("https://nodejs.org/dist/index.json"));
    const found = index.find((entry) => typeof entry.version === "string" && entry.version.startsWith("v24."));
    if (!found) fail("could not resolve latest Node.js v24.x from nodejs.org/dist/index.json");
    return found.version;
  }
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

async function buildPlatformArtifact(options) {
  const artifactRoot = await mkdtemp(join(tmpdir(), "first-tree-portable-root-"));
  try {
    const appEntry = "app/cli/index.mjs";
    cpSync(options.appTemplateDir, join(artifactRoot, "app"), { recursive: true });
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
    run("tar", ["-czf", tarballPath, "-C", artifactRoot, "."]);
    return {
      platform: options.platform,
      fileName,
      url: `${options.baseUrl}/${options.channel}/${options.version}/${fileName}`,
      sha256: sha256File(tarballPath),
      size: statSync(tarballPath).size,
    };
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
}

function renderInstallerForChannel(channel) {
  const source = readFileSync(join(SCRIPT_DIR, "install.sh"), "utf8");
  const placeholder = `$${"{FIRST_TREE_PORTABLE_CHANNEL:-prod}"}`;
  const replacement = `\${FIRST_TREE_PORTABLE_CHANNEL:-${channel}}`;
  return source.replace(`PORTABLE_CHANNEL="${placeholder}"`, `PORTABLE_CHANNEL="${replacement}"`);
}

export async function buildPortableDistribution(rawOptions) {
  const options = {
    ...rawOptions,
    outDir: resolve(rawOptions.outDir),
    downloadBaseUrl: rawOptions.downloadBaseUrl.replace(/\/+$/, ""),
  };
  validateChannelVersion(options.channel, options.version);
  assertInputBuildExists();

  const channelConfig = await loadChannelConfig(options.channel);
  if (!channelConfig.packageName) fail(`portable builds require a published package channel, got ${options.channel}`);
  const nodeVersion = await resolveNodeVersion(options.nodeVersion);
  const generatedAt = new Date().toISOString();
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

    const metadata = buildMetadata({
      channel: options.channel,
      channelConfig,
      version: options.version,
      gitSha: options.gitSha,
      nodeVersion,
      generatedAt,
    });
    const manifestUrl = `${options.downloadBaseUrl}/${options.channel}/${options.version}/manifest.json`;
    const manifest = { ...metadata, assets };
    const latest = { ...metadata, manifestUrl, assets };
    writeJson(join(versionDir, "manifest.json"), manifest);
    writeJson(join(channelDir, "latest.json"), latest);
    writeFileSync(
      join(versionDir, "SHA256SUMS"),
      `${assets.map((asset) => `${asset.sha256}  ${asset.fileName}`).join("\n")}\n`,
    );
    writeFileSync(join(channelDir, "install.sh"), renderInstallerForChannel(options.channel), { mode: 0o755 });

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
