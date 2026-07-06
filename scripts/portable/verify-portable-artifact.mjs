#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, { encoding: "utf8", ...options });
  if (res.error) fail(`${command} failed: ${res.error.message}`);
  if (res.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${res.status}\n${res.stdout ?? ""}\n${res.stderr ?? ""}`);
  }
  return res;
}

function parseArgs(argv) {
  const options = { manifest: null, platform: null, tarball: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--manifest") {
      options.manifest = value;
      i += 1;
    } else if (arg === "--platform") {
      options.platform = value;
      i += 1;
    } else if (arg === "--tarball") {
      options.tarball = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/portable/verify-portable-artifact.mjs --manifest <manifest.json> --platform <platform> --tarball <path>",
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!options.manifest || !options.platform || !options.tarball) {
    fail("--manifest, --platform, and --tarball are required");
  }
  return options;
}

function verify(options) {
  const manifest = readJson(options.manifest);
  if (manifest.schemaVersion !== 1) fail("manifest schemaVersion must be 1");
  const asset = manifest.assets?.find((candidate) => candidate.platform === options.platform);
  if (!asset) fail(`manifest missing asset for ${options.platform}`);
  const actualSha = sha256(options.tarball);
  if (actualSha !== asset.sha256) fail(`tarball sha256 mismatch: expected ${asset.sha256}, got ${actualSha}`);

  const root = mkdtempSync(join(tmpdir(), "first-tree-portable-verify-"));
  try {
    run("tar", ["-xzf", options.tarball, "-C", root]);
    for (const path of [
      "VERSION",
      "INSTALL.json",
      "node/bin/node",
      "app/package.json",
      "app/cli/index.mjs",
      `bin/${manifest.binName}`,
      `bin/${manifest.aliasName}`,
    ]) {
      if (!existsSync(join(root, path))) fail(`extracted artifact missing ${path}`);
    }
    const install = readJson(join(root, "INSTALL.json"));
    if (install.version !== manifest.version) fail("INSTALL.json version mismatch");
    if (install.platform !== options.platform) fail("INSTALL.json platform mismatch");
    if (install.appEntry !== "app/cli/index.mjs") fail("INSTALL.json appEntry mismatch");
    const packageJson = readJson(join(root, "app", "package.json"));
    if (packageJson.name !== manifest.packageName) fail("app/package.json package name mismatch");
    if (packageJson.version !== manifest.version) fail("app/package.json version mismatch");
    const versionRes = run(join(root, "bin", manifest.binName), ["--version"], {
      env: { ...process.env, FIRST_TREE_HOME: join(root, "home") },
    });
    if (!versionRes.stdout.includes(manifest.version)) {
      fail(`expected --version output to include ${manifest.version}, got ${versionRes.stdout}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  verify(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`[portable verify] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
