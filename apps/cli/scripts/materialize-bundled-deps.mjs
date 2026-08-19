#!/usr/bin/env node
/**
 * Materialize `bundleDependencies` (and the bundled packages' runtime
 * dependencies + peerDependencies that resolve from this package's
 * node_modules) as real directories before `npm pack` / `npm publish`.
 *
 * Why: the workspace is installed with pnpm, so `node_modules/<pkg>` entries are
 * symlinks into `node_modules/.pnpm/...`. npm 11.5.1's pack path follows those
 * links and writes tar entry names like `package/../../node_modules/.pnpm/...`.
 * The npm registry rejects that layout with E415 ("invalid path"). Replacing
 * the pack-time inputs with in-package real copies keeps every tar entry under
 * `package/` with no `..` traversal, while preserving `bundleDependencies` and
 * the patched Kimi SDK payload.
 *
 * Lifecycle:
 *   prepack  → node scripts/materialize-bundled-deps.mjs prepare
 *   postpack → node scripts/materialize-bundled-deps.mjs restore
 *
 * Recovery (failure-atomic):
 *   1. Preflight the full bundle closure and require every entry to still be a
 *      symlink (collect every original link target).
 *   2. Persist the COMPLETE restore journal with write-temp + rename BEFORE the
 *      first unlink/cpSync.
 *   3. Mutate. Any failure (or a later prepare that finds a stranded journal)
 *      runs idempotent restore, which can repair a mix of still-linked and
 *      already-materialized entries.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SCRIPT_DIR);
const NODE_MODULES = join(PACKAGE_ROOT, "node_modules");
const MANIFEST_PATH = join(PACKAGE_ROOT, ".bundled-deps-materialize.json");
const THIS_SCRIPT = fileURLToPath(import.meta.url);

function fail(message) {
  console.error(`materialize-bundled-deps: ${message}`);
  process.exit(1);
}

function readPackageJson(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function packageDir(name) {
  return join(NODE_MODULES, ...name.split("/"));
}

function lstatSyncSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function listBundleClosure(rootPkg) {
  const bundled = rootPkg.bundleDependencies ?? rootPkg.bundledDependencies ?? [];
  if (!Array.isArray(bundled) || bundled.length === 0) return [];

  const ordered = [];
  const seen = new Set();

  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    ordered.push(name);
    const dir = packageDir(name);
    if (!existsSync(join(dir, "package.json"))) return;
    const pkg = readPackageJson(dir);
    // Walk runtime deps and peers. Peer packages (e.g. dsh-sdk-protocol for
    // dsh-sdk-client) are required at import time but never appear in
    // `dependencies`, so a dependencies-only walk leaves the packed CLI unable
    // to start. Only materialize packages that already resolve at this
    // package's top-level node_modules — declare them as direct CLI deps so
    // pnpm hoists them here before pack.
    const runtimeDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    };
    for (const dep of Object.keys(runtimeDeps)) {
      if (existsSync(join(packageDir(dep), "package.json"))) visit(dep);
    }
  };

  for (const name of bundled) visit(name);
  return ordered;
}

/** Persist the recovery journal via write-temp + rename. */
function persistManifest(entries) {
  const tmpPath = `${MANIFEST_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  renameSync(tmpPath, MANIFEST_PATH);
}

function parseFailAfter(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fail-after") {
      const value = Number.parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 1) fail("--fail-after requires a positive integer");
      return value;
    }
    if (arg.startsWith("--fail-after=")) {
      const value = Number.parseInt(arg.slice("--fail-after=".length), 10);
      if (!Number.isFinite(value) || value < 1) fail("--fail-after requires a positive integer");
      return value;
    }
  }
  const fromEnv = process.env.MATERIALIZE_BUNDLED_DEPS_FAIL_AFTER;
  if (fromEnv !== undefined && fromEnv !== "") {
    const value = Number.parseInt(fromEnv, 10);
    if (!Number.isFinite(value) || value < 1) {
      fail("MATERIALIZE_BUNDLED_DEPS_FAIL_AFTER requires a positive integer");
    }
    return value;
  }
  return null;
}

/**
 * Read every closure entry that must be materialized. Fail closed unless each
 * path is still a recoverable symlink.
 * @returns {{ name: string, path: string, linkTarget: string, resolvedSource: string }[]}
 */
function preflightEntries(names) {
  /** @type {{ name: string, path: string, linkTarget: string, resolvedSource: string }[]} */
  const entries = [];
  for (const name of names) {
    const dir = packageDir(name);
    if (!existsSync(join(dir, "package.json")) && !lstatSyncSafe(dir)?.isSymbolicLink()) {
      throw new Error(`bundle closure package missing from node_modules: ${name}`);
    }
    const stat = lstatSyncSafe(dir);
    if (!stat) throw new Error(`cannot stat ${name}`);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `expected symlink for ${name} but found a real path; refusing to materialize without a recoverable link target`,
      );
    }
    entries.push({
      name,
      path: relative(PACKAGE_ROOT, dir),
      linkTarget: readlinkSync(dir),
      resolvedSource: realpathSync(dir),
    });
  }
  return entries;
}

function prepare(options = {}) {
  const failAfter = options.failAfter ?? null;

  if (existsSync(MANIFEST_PATH)) {
    // A previous prepare without restore (interrupted pack / crashed mutation).
    // Restore first so we never nest a real copy on top of another real copy.
    restore({ allowMissing: true });
  }

  const rootPkg = readPackageJson(PACKAGE_ROOT);
  const names = listBundleClosure(rootPkg);
  if (names.length === 0) return;

  /** @type {{ name: string, path: string, linkTarget: string, resolvedSource: string }[]} */
  let entries;
  try {
    entries = preflightEntries(names);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // Persist the COMPLETE journal before the first destructive mutation.
  const journal = entries.map(({ name, path, linkTarget }) => ({ name, path, linkTarget }));
  persistManifest(journal);

  let mutated = 0;
  try {
    for (const entry of entries) {
      const dir = join(PACKAGE_ROOT, entry.path);
      // Unlink the symlink itself — never rmSync a directory symlink without
      // care: Node may treat the target as the path and raise EISDIR.
      unlinkSync(dir);
      mkdirSync(dirname(dir), { recursive: true });
      // Copy package files only. The package directory under .pnpm has no nested
      // node_modules of its own; its deps live as sibling symlinks that we
      // materialize separately via the closure walk.
      cpSync(entry.resolvedSource, dir, { recursive: true, dereference: true });
      mutated += 1;

      // Inject only AFTER a successful real-directory replacement so restore is
      // proven against a partially-materialized workspace (not merely an unlink).
      if (failAfter !== null && mutated >= failAfter) {
        const afterCopy = lstatSyncSafe(dir);
        if (!afterCopy || afterCopy.isSymbolicLink()) {
          throw new Error("injected failure precondition failed: expected a real directory after cpSync");
        }
        throw new Error(`injected mid-prepare failure after ${mutated} successful materialization(s)`);
      }
    }
  } catch (error) {
    // Best-effort rollback from the full journal (covers partial materialize).
    try {
      restore({ allowMissing: true });
    } catch (restoreError) {
      console.error(
        `materialize-bundled-deps: restore after prepare failure also failed: ${
          restoreError instanceof Error ? restoreError.message : restoreError
        }`,
      );
    }
    fail(error instanceof Error ? error.message : String(error));
  }

  if (entries.length > 0) {
    console.log(`materialize-bundled-deps: prepared ${entries.length} pack input(s) as real directories`);
  }
}

/**
 * Idempotent restore from the journal. Each entry may still be a symlink (not
 * yet mutated) or a real directory (already copied); both become the recorded
 * original symlink target.
 */
function restore(options = {}) {
  if (!existsSync(MANIFEST_PATH)) {
    if (options.allowMissing === true) return;
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  for (const entry of entries) {
    if (typeof entry?.path !== "string" || typeof entry?.linkTarget !== "string") {
      throw new Error("restore journal entry missing path/linkTarget");
    }
    const dir = join(PACKAGE_ROOT, entry.path);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    symlinkSync(entry.linkTarget, dir);
  }
  rmSync(MANIFEST_PATH, { force: true });
  rmSync(`${MANIFEST_PATH}.${process.pid}.tmp`, { force: true });
  if (entries.length > 0) {
    console.log(`materialize-bundled-deps: restored ${entries.length} symlink(s)`);
  }
}

/**
 * Regression: capture symlink targets, force a mid-prepare failure after at
 * least one replacement, prove every original symlink is restored with no
 * stranded journal/real-copy, then prove a clean prepare+restore still works.
 */
function selftestRecovery() {
  const rootPkg = readPackageJson(PACKAGE_ROOT);
  const names = listBundleClosure(rootPkg);
  if (names.length < 2) {
    fail("selftest-recovery needs at least two bundle-closure packages to inject a mid-prepare failure");
  }

  if (existsSync(MANIFEST_PATH)) restore({ allowMissing: true });

  /** @type {Map<string, string>} */
  const before = new Map();
  for (const name of names) {
    const dir = packageDir(name);
    const stat = lstatSyncSafe(dir);
    if (!stat?.isSymbolicLink()) {
      fail(`selftest-recovery precondition failed: ${name} is not a symlink`);
    }
    before.set(name, readlinkSync(dir));
  }

  // Child fails after the first successful cpSync (real directory present) and
  // before the next entry, so restore must delete that copy and recreate every
  // original symlink from the preflight journal.
  const child = spawnSync(process.execPath, [THIS_SCRIPT, "prepare", "--fail-after=1"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (child.status === 0) {
    fail("selftest-recovery expected prepare --fail-after=1 to exit non-zero");
  }
  const childOut = `${child.stdout}\n${child.stderr}`;
  if (!childOut.includes("successful materialization")) {
    fail(`selftest-recovery expected failure after a successful copy, got:\n${childOut}`);
  }

  if (existsSync(MANIFEST_PATH)) {
    fail("selftest-recovery left a stranded restore manifest");
  }

  for (const name of names) {
    const dir = packageDir(name);
    const stat = lstatSyncSafe(dir);
    if (!stat?.isSymbolicLink()) {
      fail(`selftest-recovery did not restore symlink for ${name}`);
    }
    const target = readlinkSync(dir);
    if (target !== before.get(name)) {
      fail(`selftest-recovery restored wrong target for ${name}: ${target} (want ${before.get(name)})`);
    }
  }

  // Clean prepare + restore must still succeed after the failure path.
  const prepareOk = spawnSync(process.execPath, [THIS_SCRIPT, "prepare"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (prepareOk.status !== 0) {
    fail(`selftest-recovery follow-up prepare failed:\n${prepareOk.stderr || prepareOk.stdout}`);
  }
  if (!existsSync(MANIFEST_PATH)) {
    fail("selftest-recovery follow-up prepare did not leave a restore manifest");
  }
  for (const name of names) {
    const dir = packageDir(name);
    if (lstatSyncSafe(dir)?.isSymbolicLink()) {
      fail(`selftest-recovery follow-up prepare left ${name} as a symlink`);
    }
  }
  const restoreOk = spawnSync(process.execPath, [THIS_SCRIPT, "restore"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (restoreOk.status !== 0) {
    fail(`selftest-recovery follow-up restore failed:\n${restoreOk.stderr || restoreOk.stdout}`);
  }
  if (existsSync(MANIFEST_PATH)) {
    fail("selftest-recovery follow-up restore left a stranded manifest");
  }
  for (const name of names) {
    const dir = packageDir(name);
    const stat = lstatSyncSafe(dir);
    if (!stat?.isSymbolicLink()) {
      fail(`selftest-recovery follow-up restore did not restore symlink for ${name}`);
    }
    if (readlinkSync(dir) !== before.get(name)) {
      fail(`selftest-recovery follow-up restore wrong target for ${name}`);
    }
  }

  console.log(
    `materialize-bundled-deps: selftest-recovery PASS (${names.length} symlinks restored after mid-prepare failure; clean prepare/restore ok)`,
  );
}

const argv = process.argv.slice(2);
const action = argv[0] ?? "prepare";
if (action === "prepare") prepare({ failAfter: parseFailAfter(argv.slice(1)) });
else if (action === "restore") restore();
else if (action === "selftest-recovery") selftestRecovery();
else fail(`unknown action '${action}' (expected prepare|restore|selftest-recovery)`);
