#!/usr/bin/env node
/**
 * Release-pack smoke: prove the public npm packaging boundary works for the
 * built CLI under the trusted-publishing npm client the workflow pins.
 *
 *   1. `npm pack` the built apps/cli package through REAL pack semantics
 *      (prepack copies public Skills + private variants and materializes bundled deps, postpack restores —
 *      no --ignore-scripts), writing the tarball into a run-owned temp
 *      directory via `--pack-destination` so apps/cli is never overwritten.
 *   2. Enumerate every tarball entry and reject traversal / absolute /
 *      escaping-link / non-canonical package paths (the npm registry E415 class).
 *   3. Install the tarball into an empty consumer with plain npm.
 *   4. Run the public CLI (`--version`).
 *   5. Fail-closed if the built `context-integration` release payload is
 *      missing from the pack source or from the empty-consumer install
 *      (guards Turbo cache hits that restore only `dist/**`).
 *   6. Resolve the bundled `@botiverse/kimi-code-sdk` from the consumer and
 *      assert the patched sites this release ships: create-time drain flag,
 *      resume option threading, resume main-agent flag application, and the
 *      awaited replay-fence authorization hook.
 *
 * Failures throw; the outermost handler always cleans *this run's* pack
 * destination, temp consumers, and any stranded materialize journal before
 * exiting non-zero. Pre-existing `first-tree-dev-*.tgz` files in apps/cli —
 * including ones that share npm pack's deterministic current name/version —
 * are snapshotted by path+digest and never overwritten or deleted. Helpers
 * never call `process.exit`.
 *
 * No registry publish, no credentials, no network beyond npm itself.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNpmTarballRegistrySafe, listNpmTarballEntries } from "./npm-tarball-safety.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CLI_ROOT = join(REPO_ROOT, "apps", "cli");
const MATERIALIZE_SCRIPT = join(CLI_ROOT, "scripts", "materialize-bundled-deps.mjs");
const MANIFEST_PATH = join(CLI_ROOT, ".bundled-deps-materialize.json");
const CONTEXT_INTEGRATION_ROOT = join(CLI_ROOT, "context-integration");
const CONTEXT_INTEGRATION_MANIFEST = join(CONTEXT_INTEGRATION_ROOT, "release-manifest.json");
const PACKAGED_CONTEXT_MANIFEST_ENTRY = "package/context-integration/release-manifest.json";
const PACKAGED_LOCAL_SKILL_VARIANT_ENTRIES = [
  "package/skills/.variants/local-context/first-tree-read/SKILL.md",
  "package/skills/.variants/local-context/first-tree-write/SKILL.md",
];

class SmokeFailure extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SmokeFailure";
  }
}

function fail(message) {
  throw new SmokeFailure(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} exited ${result.status}\n${detail}`);
  }
  return result;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listCliTarballs() {
  return readdirSync(CLI_ROOT)
    .filter((name) => /^first-tree-dev-.*\.tgz$/.test(name))
    .map((name) => join(CLI_ROOT, name))
    .sort();
}

function expectedPackFilename() {
  const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8"));
  const name = String(pkg.name ?? "")
    .replace(/^@/, "")
    .replace(/\//g, "-");
  return `${name}-${pkg.version}.tgz`;
}

/**
 * Path → sha256 digest for every pre-existing apps/cli tarball. Digests catch
 * same-name overwrites that path-only ownership cannot see.
 * @type {Map<string, string>}
 */
const preexistingTarballDigests = new Map();

/** @type {string | undefined} Active run-owned work directory (pack + consumer). */
let activeWorkDir;

function snapshotPreexistingTarballs() {
  preexistingTarballDigests.clear();
  for (const tarball of listCliTarballs()) {
    preexistingTarballDigests.set(tarball, sha256File(tarball));
  }
}

/**
 * Pack into a run-owned destination so npm's deterministic filename cannot
 * overwrite a developer artifact already present under apps/cli.
 * @param {string} packDestination
 * @returns {string} absolute path of the packed tarball
 */
function packCliInto(packDestination) {
  // npm pack does not create pack-destination; missing dirs surface as ENOENT
  // while writing the deterministic tarball name.
  mkdirSync(packDestination, { recursive: true });
  run("npm", ["pack", "--json", "--pack-destination", packDestination], { cwd: CLI_ROOT });
  const expectedName = expectedPackFilename();
  const tarball = join(packDestination, expectedName);
  if (!existsSync(tarball)) {
    const found = readdirSync(packDestination).filter((name) => name.endsWith(".tgz"));
    fail(`expected packed tarball at ${tarball}, found: ${found.join(", ") || "(none)"}`);
  }
  return tarball;
}

/**
 * Remove only run-owned temp work (pack destination + consumer) and any
 * stranded materialize journal. Never deletes or rewrites apps/cli tarballs.
 * @param {string | undefined} workDir
 */
function cleanupPackArtifacts(workDir) {
  const target = workDir ?? activeWorkDir;
  activeWorkDir = undefined;
  if (target) {
    rmSync(target, { recursive: true, force: true });
  }
  if (existsSync(MANIFEST_PATH)) {
    const restore = spawnSync(process.execPath, [MATERIALIZE_SCRIPT, "restore"], {
      cwd: CLI_ROOT,
      encoding: "utf8",
    });
    if (restore.status !== 0) {
      console.error(
        `release-pack-smoke: WARNING: materialize restore during cleanup failed:\n${restore.stderr || restore.stdout}`,
      );
    }
  }
}

/**
 * @param {Map<string, string>} symlinkSnapshot
 */
function assertCleanWorkspace(symlinkSnapshot) {
  const current = new Set(listCliTarballs());
  for (const tarball of current) {
    if (!preexistingTarballDigests.has(tarball)) {
      fail(`cleanup left work-owned tarball residue under apps/cli: ${tarball}`);
    }
  }
  for (const [tarball, digest] of preexistingTarballDigests) {
    if (!existsSync(tarball)) {
      fail(`cleanup deleted pre-existing tarball it does not own: ${tarball}`);
    }
    const now = sha256File(tarball);
    if (now !== digest) {
      fail(`pre-existing tarball was overwritten or altered: ${tarball} (was ${digest}, now ${now})`);
    }
  }
  if (existsSync(MANIFEST_PATH)) {
    fail("cleanup left stranded materialize manifest");
  }
  for (const [name, target] of symlinkSnapshot) {
    const dir = join(CLI_ROOT, "node_modules", ...name.split("/"));
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      fail(`cleanup missing package path for ${name}`);
    }
    if (!stat.isSymbolicLink()) {
      fail(`cleanup left real copy instead of symlink for ${name}`);
    }
    if (readlinkSync(dir) !== target) {
      fail(`cleanup restored wrong symlink target for ${name}`);
    }
  }
}

/**
 * Fail closed before pack when the release payload Turbo must restore is gone
 * (postpack deletes it; a dist-only cache hit must not silently pack without it).
 * @returns {{ version: string, bundleDigest: string, providers: string[] }}
 */
function assertSourceContextIntegrationPresent() {
  if (!existsSync(CONTEXT_INTEGRATION_MANIFEST)) {
    fail(
      "apps/cli/context-integration/release-manifest.json is missing — run a full `pnpm build` that restores context-integration/** (Turbo build outputs must include it)",
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(CONTEXT_INTEGRATION_MANIFEST, "utf8"));
  } catch (error) {
    fail(
      `apps/cli/context-integration/release-manifest.json is not valid JSON: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  if (!manifest || typeof manifest !== "object" || typeof manifest.bundleDigest !== "string") {
    fail("apps/cli/context-integration/release-manifest.json is missing bundleDigest");
  }
  if (
    typeof manifest.core?.digest !== "string" ||
    typeof manifest.core?.policy?.path !== "string" ||
    typeof manifest.core?.skills?.["first-tree-read"]?.path !== "string" ||
    typeof manifest.core?.skills?.["first-tree-write"]?.path !== "string"
  ) {
    fail("apps/cli/context-integration/release-manifest.json is missing exact-release Core entries");
  }
  const providers = Object.keys(manifest.providers ?? {});
  if (providers.length < 1) {
    fail("apps/cli/context-integration/release-manifest.json declares no providers");
  }
  for (const provider of providers) {
    const providerRoot = join(CONTEXT_INTEGRATION_ROOT, provider);
    if (!existsSync(providerRoot)) {
      fail(`apps/cli/context-integration missing provider payload directory: ${provider}`);
    }
    assertThinContextAdapter(providerRoot, provider);
  }
  return {
    version: String(manifest.version ?? ""),
    bundleDigest: manifest.bundleDigest,
    providers,
    core: manifest.core,
  };
}

/**
 * @param {string} consumerDir
 * @param {{ bundleDigest: string, providers: string[], core: {policy: {path: string}, skills: Record<string, {path: string}>} }} source
 */
function assertConsumerContextIntegration(consumerDir, source) {
  const packagedRoot = join(consumerDir, "node_modules", "first-tree-dev", "context-integration");
  const packagedManifestPath = join(packagedRoot, "release-manifest.json");
  if (!existsSync(packagedManifestPath)) {
    fail(`consumer is missing packaged context-integration/release-manifest.json at ${packagedManifestPath}`);
  }
  const packaged = JSON.parse(readFileSync(packagedManifestPath, "utf8"));
  if (packaged.bundleDigest !== source.bundleDigest) {
    fail(
      `consumer context-integration bundleDigest mismatch: source=${source.bundleDigest} packaged=${packaged.bundleDigest}`,
    );
  }
  for (const provider of source.providers) {
    const providerRoot = join(packagedRoot, provider);
    if (!existsSync(providerRoot)) {
      fail(`consumer context-integration missing provider payload: ${provider}`);
    }
    assertThinContextAdapter(providerRoot, provider);
  }
  const packageRoot = join(consumerDir, "node_modules", "first-tree-dev");
  for (const entry of [source.core.policy, ...Object.values(source.core.skills)]) {
    if (!existsSync(join(packageRoot, entry.path))) {
      fail(`consumer is missing exact-release Context Core entry: ${entry.path}`);
    }
  }
}

/**
 * Execute the public loader from the empty npm consumer and prove it fails
 * closed. npm installs are updated in place, so this package root is not an
 * immutable exact release root and must never be returned to a BYO task.
 * @param {string} consumerDir
 * @param {string} binPath
 * @param {{ core: {policy: {path: string, digest: string}, skills: Record<string, {path: string, digest: string}>} }} source
 * @param {string} home
 */
function assertConsumerContextLoaderFailsClosed(_consumerDir, binPath, _source, home) {
  mkdirSync(home, { recursive: true });
  const result = spawnSync(
    binPath,
    ["--json", "context", "skill", "load", "--protocol", "1", "--provider", "codex", "--name", "first-tree-read"],
    { env: { ...process.env, FIRST_TREE_HOME: home }, encoding: "utf8" },
  );
  if (result.error) fail(`packed Context loader failed to start: ${result.error.message}`);
  let envelope;
  try {
    envelope = JSON.parse(result.stderr);
  } catch {
    fail(`packed mutable-root Context loader did not return a typed JSON failure: ${result.stderr || result.stdout}`);
  }
  if (
    result.status === 0 ||
    envelope?.ok !== false ||
    envelope?.error?.code !== "CONTEXT_SKILL_RELEASE_ROOT_UNTRUSTED"
  ) {
    fail("packed mutable-root Context loader did not fail closed with CONTEXT_SKILL_RELEASE_ROOT_UNTRUSTED");
  }
}

function assertPinnedPortableContextLoader(consumerDir, work, version, source) {
  const packageRoot = join(consumerDir, "node_modules", "first-tree-dev");
  const appRoot = join(work, "portable", "versions", version, "app");
  cpSync(packageRoot, appRoot, { recursive: true });
  linkPortableSmokeDependencies(join(consumerDir, "node_modules"), join(appRoot, "node_modules"));
  const result = run(
    process.execPath,
    [
      join(appRoot, "dist", "cli", "index.mjs"),
      "--json",
      "context",
      "skill",
      "load",
      "--protocol",
      "1",
      "--provider",
      "codex",
      "--name",
      "first-tree-read",
    ],
    { env: { ...process.env, FIRST_TREE_HOME: join(work, "portable-home") } },
  );
  const envelope = JSON.parse(result.stdout);
  const data = envelope?.ok === true ? envelope.data : null;
  if (
    data?.skillPath !== resolve(appRoot, source.core.skills["first-tree-read"].path) ||
    data?.policyPath !== resolve(appRoot, source.core.policy.path)
  ) {
    fail("version-pinned portable Context loader did not return paths from its immutable app root");
  }
}

function linkPortableSmokeDependencies(sourceRoot, targetRoot) {
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot)) {
    if (entry === ".bin" || entry === "first-tree-dev") continue;
    const source = join(sourceRoot, entry);
    const target = join(targetRoot, entry);
    if (!existsSync(target)) {
      symlinkSync(source, target, "dir");
      continue;
    }
    if (!entry.startsWith("@")) continue;
    for (const packageName of readdirSync(source)) {
      const scopedTarget = join(target, packageName);
      if (!existsSync(scopedTarget)) symlinkSync(join(source, packageName), scopedTarget, "dir");
    }
  }
}

function assertThinContextAdapter(providerRoot, provider) {
  const pluginRoot = join(providerRoot, "plugins", "first-tree-context");
  for (const skill of ["first-tree-read", "first-tree-write"]) {
    const skillRoot = join(pluginRoot, "skills", skill);
    if (JSON.stringify(readdirSync(skillRoot).sort()) !== JSON.stringify(["SKILL.md"])) {
      fail(`${provider} Context Plugin ${skill} is not a thin single-file loader stub`);
    }
    const body = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
    if (!body.includes("context skill load --protocol 1") || body.includes("context write-preflight")) {
      fail(`${provider} Context Plugin ${skill} contains a copied or invalid Core workflow`);
    }
  }
}

/**
 * @param {string} tarballPath
 */
function assertTarballContainsContextIntegration(tarballPath) {
  const entries = listNpmTarballEntries(tarballPath);
  if (!entries.some((entry) => entry.name === PACKAGED_CONTEXT_MANIFEST_ENTRY)) {
    fail(`tarball is missing ${PACKAGED_CONTEXT_MANIFEST_ENTRY}`);
  }
}

function assertTarballContainsLocalSkillVariants(tarballPath) {
  const entries = listNpmTarballEntries(tarballPath);
  for (const required of PACKAGED_LOCAL_SKILL_VARIANT_ENTRIES) {
    if (entries.filter((entry) => entry.name === required).length !== 1) {
      fail(`tarball must contain exactly one ${required}`);
    }
  }
  const publicSkillNames = entries
    .map((entry) => /^package\/skills\/([^/]+)\/SKILL\.md$/u.exec(entry.name)?.[1] ?? null)
    .filter((name) => name !== null);
  for (const name of ["first-tree-read", "first-tree-write"]) {
    if (publicSkillNames.filter((candidate) => candidate === name).length !== 1) {
      fail(`tarball public Skill inventory must contain exactly one ${name}`);
    }
  }
}

function captureBundledSymlinks() {
  /** @type {Map<string, string>} */
  const snapshot = new Map();
  const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8"));
  const bundled = pkg.bundleDependencies ?? [];
  const names = new Set(bundled);
  for (const name of bundled) {
    const dir = join(CLI_ROOT, "node_modules", ...name.split("/"));
    try {
      const depPkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const runtimeDeps = {
        ...(depPkg.dependencies ?? {}),
        ...(depPkg.peerDependencies ?? {}),
      };
      for (const dep of Object.keys(runtimeDeps)) {
        if (existsSync(join(CLI_ROOT, "node_modules", ...dep.split("/"), "package.json"))) {
          names.add(dep);
        }
      }
    } catch {
      // ignore — prepare/preflight owns hard failures
    }
  }
  for (const name of names) {
    const dir = join(CLI_ROOT, "node_modules", ...name.split("/"));
    const stat = lstatSync(dir);
    if (!stat.isSymbolicLink()) {
      fail(`precondition: ${name} must be a pnpm symlink before smoke`);
    }
    snapshot.set(name, readlinkSync(dir));
  }
  return snapshot;
}

function runSmoke() {
  if (!existsSync(join(CLI_ROOT, "dist", "cli", "index.mjs")) || !existsSync(join(CLI_ROOT, "dist", "index.mjs"))) {
    fail("apps/cli/dist is missing — run `pnpm build` first");
  }
  const contextIntegration = assertSourceContextIntegrationPresent();

  const symlinkSnapshot = captureBundledSymlinks();
  const work = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-release-pack-smoke-"));
  activeWorkDir = work;
  try {
    const packDir = join(work, "pack");
    const consumerDir = join(work, "consumer");
    const tarball = packCliInto(packDir);
    const tarballName = basename(tarball);

    const safety = assertNpmTarballRegistrySafe(tarball);
    assertTarballContainsContextIntegration(tarball);
    assertTarballContainsLocalSkillVariants(tarball);

    run("npm", ["install", "--prefix", consumerDir, tarball]);
    const binName = "first-tree-dev";
    const binPath = join(consumerDir, "node_modules", ".bin", binName);
    if (!existsSync(binPath)) fail(`consumer is missing ${binPath}`);
    const version = run(binPath, ["--version"]);
    const versionText = version.stdout.trim();
    if (!/^\d+\.\d+\.\d+/.test(versionText)) fail(`unexpected --version output: ${versionText}`);

    assertConsumerContextIntegration(consumerDir, contextIntegration);
    assertConsumerContextLoaderFailsClosed(consumerDir, binPath, contextIntegration, join(work, "first-tree-home"));
    assertPinnedPortableContextLoader(consumerDir, work, versionText, contextIntegration);

    const sdkEntry = join(
      consumerDir,
      "node_modules",
      "first-tree-dev",
      "node_modules",
      "@botiverse",
      "kimi-code-sdk",
      "dist",
      "index.mjs",
    );
    if (!existsSync(sdkEntry)) {
      fail(`consumer did not resolve the bundled Kimi SDK at ${sdkEntry} — bundleDependencies is not shipping`);
    }
    const source = readFileSync(sdkEntry, "utf8");
    const requiredSites = [
      ["create drain flag", "if (this.options.drainAgentTasksOnStop) agent.printDrainAgentTasksOnStop = true"],
      ["resume option threading", "drainAgentTasksOnStop: input.drainAgentTasksOnStop"],
      ["resume main-agent flag", "this.options.drainAgentTasksOnStop) main.printDrainAgentTasksOnStop = true"],
      ["awaited replay-fence authorization hook", "__firstTreeBeforeToolCall"],
    ];
    for (const [label, needle] of requiredSites) {
      if (!source.includes(needle)) fail(`bundled Kimi SDK is missing the ${label} site`);
    }

    run(process.execPath, [
      "-e",
      `import(${JSON.stringify(`file://${sdkEntry}`)}).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); })`,
    ]);

    const deepseekProtocolEntry = join(
      consumerDir,
      "node_modules",
      "first-tree-dev",
      "node_modules",
      "@deepseek-ai",
      "dsh-sdk-protocol",
      "package.json",
    );
    if (!existsSync(deepseekProtocolEntry)) {
      fail(
        `consumer is missing bundled @deepseek-ai/dsh-sdk-protocol at ${deepseekProtocolEntry} — DeepSeek SDK peer closure is not shipping`,
      );
    }
    const packagedCliRoot = join(consumerDir, "node_modules", "first-tree-dev");
    run(
      process.execPath,
      ["--input-type=module", "-e", "import '@deepseek-ai/dsh-sdk-client'; console.log('deepseek-client-ok')"],
      {
        cwd: packagedCliRoot,
        env: {
          ...process.env,
          NODE_PATH: join(packagedCliRoot, "node_modules"),
        },
      },
    );

    const sha256 = sha256File(tarball);
    const bytes = statSync(tarball).size;
    console.log(
      `release-pack-smoke: PASS — packed ${tarballName} (${bytes} B, sha256=${sha256}, ${safety.entryCount} entries), consumer CLI ${versionText}, registry-safe paths, exact-release Context loader ${contextIntegration.bundleDigest}, bundled patched Kimi SDK verified, DeepSeek SDK peer closure verified`,
    );
  } finally {
    cleanupPackArtifacts(work);
    assertCleanWorkspace(symlinkSnapshot);
  }
}

/**
 * Deterministic negative cleanup regression: pack succeeds into a run-owned
 * destination, then an injected post-pack failure must still remove that
 * work tree and restore symlinks — without touching apps/cli tarballs.
 */
function selftestCleanup() {
  if (!existsSync(join(CLI_ROOT, "dist", "cli", "index.mjs"))) {
    fail("apps/cli/dist is missing — run `pnpm build` before selftest-cleanup");
  }
  const symlinkSnapshot = captureBundledSymlinks();
  const work = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-release-pack-smoke-neg-"));
  activeWorkDir = work;
  let failedAsExpected = false;
  let packedPath;
  try {
    try {
      packedPath = packCliInto(join(work, "pack"));
      if (!existsSync(packedPath)) fail("selftest-cleanup: pack did not produce a tarball");
      fail("injected post-pack failure for cleanup regression");
    } catch (error) {
      if (!(error instanceof SmokeFailure) || !error.message.includes("injected post-pack failure")) {
        throw error;
      }
      failedAsExpected = true;
    }
  } finally {
    cleanupPackArtifacts(work);
  }

  if (!failedAsExpected) fail("selftest-cleanup did not take the injected failure path");
  assertCleanWorkspace(symlinkSnapshot);
  if (existsSync(work)) fail("selftest-cleanup left consumer work directory");
  if (packedPath && existsSync(packedPath)) fail("selftest-cleanup left run-owned packed tarball");
  console.log("release-pack-smoke: selftest-cleanup PASS");
}

/**
 * Assert the deterministic apps/cli collision path still holds the exact
 * preexisting bytes/digest, then that run-owned residue is gone and bundled
 * symlinks match the pre-smoke snapshot.
 * @param {string} collisionPath
 * @param {string} expectedDigest
 * @param {Buffer} expectedBytes
 * @param {Map<string, string>} symlinkSnapshot
 * @param {string} phase
 * @param {string | undefined} workDir
 * @param {string | undefined} packedPath
 */
function assertPreservedCollision(
  collisionPath,
  expectedDigest,
  expectedBytes,
  symlinkSnapshot,
  phase,
  workDir,
  packedPath,
) {
  if (!existsSync(collisionPath)) {
    fail(`selftest-preserve [${phase}]: deterministic preexisting tarball missing`);
  }
  const digest = sha256File(collisionPath);
  if (digest !== expectedDigest) {
    fail(`selftest-preserve [${phase}]: digest changed (was ${expectedDigest}, now ${digest})`);
  }
  if (Buffer.compare(readFileSync(collisionPath), expectedBytes) !== 0) {
    fail(`selftest-preserve [${phase}]: preexisting bytes changed`);
  }
  assertCleanWorkspace(symlinkSnapshot);
  if (workDir && existsSync(workDir)) {
    fail(`selftest-preserve [${phase}]: left run-owned work directory`);
  }
  if (packedPath && existsSync(packedPath)) {
    fail(`selftest-preserve [${phase}]: left run-owned packed tarball`);
  }
  if (existsSync(MANIFEST_PATH)) {
    fail(`selftest-preserve [${phase}]: left stranded materialize manifest`);
  }
}

/**
 * Prove pack destination isolation preserves a pre-existing artifact that
 * already uses npm pack's deterministic current name/version filename
 * (e.g. first-tree-dev-0.5.18.tgz) — verified by exact bytes + sha256 across
 * success cleanup, post-pack failure cleanup, and invalid/early failure cleanup.
 */
function selftestPreservePreexistingTarball() {
  const deterministicName = expectedPackFilename();
  const collisionPath = join(CLI_ROOT, deterministicName);
  // Fixed 31-byte sentinel matching the real collision shape reviewers reproduce.
  const sentinelBody = Buffer.from("preexisting-sentinel-31-bytes!\n", "utf8");
  if (sentinelBody.length !== 31) {
    fail(`selftest-preserve: sentinel must be 31 bytes, got ${sentinelBody.length}`);
  }
  const createdBySelftest = !existsSync(collisionPath);
  if (createdBySelftest) {
    writeFileSync(collisionPath, sentinelBody);
  }
  const expectedBytes = readFileSync(collisionPath);
  const expectedDigest = sha256File(collisionPath);

  try {
    snapshotPreexistingTarballs();
    if (!preexistingTarballDigests.has(collisionPath)) {
      fail("selftest-preserve: deterministic preexisting tarball was not snapshotted");
    }
    if (preexistingTarballDigests.get(collisionPath) !== expectedDigest) {
      fail("selftest-preserve: snapshot digest mismatch before pack");
    }

    if (!existsSync(join(CLI_ROOT, "dist", "cli", "index.mjs"))) {
      fail("apps/cli/dist is missing — run `pnpm build` before selftest-preserve-preexisting");
    }
    const symlinkSnapshot = captureBundledSymlinks();

    // 1) Success-path: pack into run-owned destination; collision path untouched.
    {
      const work = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-release-pack-smoke-preserve-ok-"));
      activeWorkDir = work;
      let packed;
      try {
        packed = packCliInto(join(work, "pack"));
        if (basename(packed) !== deterministicName) {
          fail(`selftest-preserve: packed name ${basename(packed)} !== ${deterministicName}`);
        }
        if (sha256File(packed) === expectedDigest) {
          fail("selftest-preserve: packed artifact unexpectedly matched preexisting digest");
        }
        if (sha256File(collisionPath) !== expectedDigest) {
          fail("selftest-preserve: pack overwrote the deterministic preexisting tarball");
        }
      } finally {
        cleanupPackArtifacts(work);
      }
      assertPreservedCollision(collisionPath, expectedDigest, expectedBytes, symlinkSnapshot, "success", work, packed);
    }

    // 2) Post-pack failure: pack succeeds into temp, then injected failure cleanup
    // must remove run-owned outputs without touching the collision path.
    {
      const work = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-release-pack-smoke-preserve-post-"));
      activeWorkDir = work;
      let packed;
      let failedAsExpected = false;
      try {
        try {
          packed = packCliInto(join(work, "pack"));
          fail("injected post-pack failure for preexisting preservation");
        } catch (error) {
          if (!(error instanceof SmokeFailure) || !error.message.includes("injected post-pack failure")) {
            throw error;
          }
          failedAsExpected = true;
        }
      } finally {
        cleanupPackArtifacts(work);
      }
      if (!failedAsExpected) fail("selftest-preserve: post-pack failure path not taken");
      assertPreservedCollision(
        collisionPath,
        expectedDigest,
        expectedBytes,
        symlinkSnapshot,
        "post-pack-failure",
        work,
        packed,
      );
    }
    try {
      fail("injected early failure for preexisting preservation");
    } catch (error) {
      if (!(error instanceof SmokeFailure) || !error.message.includes("injected early failure")) {
        throw error;
      }
      cleanupPackArtifacts(undefined);
    }
    assertPreservedCollision(
      collisionPath,
      expectedDigest,
      expectedBytes,
      symlinkSnapshot,
      "early-failure",
      undefined,
      undefined,
    );

    console.log(
      `release-pack-smoke: selftest-preserve-preexisting PASS — preserved ${deterministicName} sha256=${expectedDigest} across success/post-pack/early failure`,
    );
  } finally {
    if (createdBySelftest) {
      rmSync(collisionPath, { force: true });
    }
    preexistingTarballDigests.delete(collisionPath);
  }
}

/**
 * Neuter regression: populate a private Turbo cache from a full CLI build,
 * delete context-integration (as postpack does), then prove a cache-hit build
 * restores the release payload so pack smoke stays complete (not the 817-entry
 * dist-only false green).
 */
function selftestTurboContextIntegrationCache() {
  const turboJson = JSON.parse(readFileSync(join(CLI_ROOT, "turbo.json"), "utf8"));
  const outputs = turboJson?.tasks?.build?.outputs;
  if (!Array.isArray(outputs) || !outputs.includes("context-integration/**")) {
    fail('apps/cli/turbo.json build.outputs must include "context-integration/**"');
  }
  if (!outputs.includes("dist/**")) {
    fail('apps/cli/turbo.json build.outputs must include "dist/**"');
  }

  const cacheDir = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-turbo-ci-cache-"));
  try {
    // Force a real build into an isolated cache so outputs include the payload.
    run("pnpm", ["exec", "turbo", "run", "build", "--filter=first-tree-dev", "--force", "--cache-dir", cacheDir], {
      cwd: REPO_ROOT,
    });
    const seeded = assertSourceContextIntegrationPresent();
    const seededDigest = seeded.bundleDigest;

    rmSync(CONTEXT_INTEGRATION_ROOT, { recursive: true, force: true });
    if (existsSync(CONTEXT_INTEGRATION_MANIFEST)) {
      fail("selftest-turbo-cache: failed to delete context-integration before cache-hit build");
    }

    const hit = run("pnpm", ["exec", "turbo", "run", "build", "--filter=first-tree-dev", "--cache-dir", cacheDir], {
      cwd: REPO_ROOT,
    });
    const hitLog = `${hit.stdout}\n${hit.stderr}`;
    if (!/first-tree-dev:build:\s*cache (hit|HIT)/i.test(hitLog) && !/cache hit/i.test(hitLog)) {
      // Turbo prints "cache hit, replaying logs" — accept either stream.
      if (!/cache hit/i.test(hitLog)) {
        fail(`selftest-turbo-cache: expected cache hit for first-tree-dev#build\n${hitLog}`);
      }
    }

    const restored = assertSourceContextIntegrationPresent();
    if (restored.bundleDigest !== seededDigest) {
      fail(`selftest-turbo-cache: restored bundleDigest ${restored.bundleDigest} !== seeded ${seededDigest}`);
    }

    // Pack smoke must remain complete after a cache-hit restore (not 817 / dist-only).
    runSmoke();
    console.log(
      `release-pack-smoke: selftest-turbo-context-integration-cache PASS — restored ${seededDigest} via turbo cache hit`,
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

function main() {
  snapshotPreexistingTarballs();
  const action = process.argv[2];
  try {
    if (action === "selftest-cleanup") selftestCleanup();
    else if (action === "selftest-preserve-preexisting") selftestPreservePreexistingTarball();
    else if (action === "selftest-turbo-context-integration-cache") selftestTurboContextIntegrationCache();
    else if (action === undefined) runSmoke();
    else
      fail(
        `unknown action '${action}' (expected default smoke, selftest-cleanup, selftest-preserve-preexisting, or selftest-turbo-context-integration-cache)`,
      );
  } catch (error) {
    try {
      cleanupPackArtifacts(undefined);
    } catch (cleanupError) {
      console.error(
        `release-pack-smoke: cleanup after failure also failed: ${
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        }`,
      );
    }
    console.error(`release-pack-smoke: FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

main();
