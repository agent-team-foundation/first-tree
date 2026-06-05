import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classify, ERROR_KINDS, getChildProcessRegistry } from "@first-tree/client";
import { inferChannelFromVersion } from "@first-tree/shared/channel";
import * as semver from "semver";
import { resolveServerUrl } from "./bootstrap.js";
import { channelConfig } from "./channel.js";
import { cliFetch } from "./cli-fetch.js";
import { print } from "./output.js";

/** Hard ceiling on a single `npm install -g` invocation (5 min). */
const NPM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export type InstallMode = "global" | "npx" | "source";
export type VersionLookupResult = { ok: true; version: string } | { ok: false; reason: string };

/**
 * npm package name this binary self-updates against. Derived from the
 * channel (`first-tree`, `first-tree-staging`, or `null` for dev — dev
 * binaries are not published and refuse self-update entirely).
 */
export const PACKAGE_NAME = channelConfig.packageName;

/**
 * Pick the `npm` binary to invoke for self-update. Background service units
 * prepend the current Node directory to PATH, but also prefer the sibling
 * npm explicitly so self-update stays aligned with the Node toolchain that
 * launched the daemon. If that sibling is missing (e.g. corporate custom
 * layout), fall back to PATH lookup.
 */
function resolveNpmCommand(): string {
  const binName = process.platform === "win32" ? "npm.cmd" : "npm";
  const sibling = join(dirname(process.execPath), binName);
  if (existsSync(sibling)) return sibling;
  return "npm";
}

/**
 * Detect how the CLI was launched. Used by the update path to decide whether
 * `npm install -g <pkg>@latest` makes sense.
 *
 *  - `"global"`: launched from an `npm install -g` install. The self-update
 *    can reinstall the same package at a caller-selected spec.
 *  - `"source"`: launched from inside a git checkout (dev / monorepo). Update
 *    is a no-op; operator should `git pull`.
 *  - `"npx"` (fallback): any other path (e.g. one-shot `npx`, pnpm dlx). Auto
 *    update is not safe; log a hint and skip.
 */
export function detectInstallMode(
  argv1: string = process.argv[1] ?? "",
  packageName: string | null = PACKAGE_NAME,
): InstallMode {
  // dev channel is not published to npm — there is no `node_modules/<pkg>`
  // tree to detect a "global" install against. Treat dev binaries as
  // running from source so the update path declines self-update with the
  // "use git pull" hint.
  if (packageName === null) return "source";
  if (!argv1) return "npx";
  // Resolve symlinks first. Standard `npm i -g` lays the binary out as
  // `<prefix>/bin/<name> -> ../lib/node_modules/<pkg>/dist/cli/index.mjs`,
  // and `process.argv[1]` keeps the symlink path. Walking from the link
  // dir (`<prefix>/bin/`) never hits an ancestor `package.json` matching
  // our name, so the function falls through to "npx" and `update` refuses
  // to run on a perfectly valid global install. realpathSync moves the
  // walk start into the package tree where detection actually works.
  // Wrapped in try/catch because argv1 may be a path that no longer
  // exists on disk (overridden process.argv[1], odd test fixtures).
  let resolvedArgv1: string;
  try {
    resolvedArgv1 = realpathSync(argv1);
  } catch {
    resolvedArgv1 = argv1;
  }
  // Cap at 10 levels to avoid runaway walks on exotic symlink layouts.
  const start = dirname(resolve(resolvedArgv1));

  // A globally-installed (or npx-cached) package always lives under a
  // `node_modules/` directory, never directly inside a source checkout.
  // Skip the ancestor-`.git` scan in that case — otherwise we mis-classify
  // legitimate installs as "source" whenever the install prefix happens to
  // sit inside a git-tracked directory. Real-world triggers: a Homebrew
  // prefix that was `git init`-ed by the operator, a `$HOME` managed by
  // dotfiles tools (yadm / chezmoi / homeshick) combined with
  // `npm config set prefix ~/.local`, or a CI image that tracks the whole
  // root with git. Symptom: `update` silently prints
  // "Running from source checkout — self-update skipped" forever and the
  // client never picks up new versions.
  const inNodeModules = /(?:^|[\\/])node_modules[\\/]/.test(resolvedArgv1);

  // Pass 1: any ancestor with a `.git` dir means we're inside a checkout.
  // This MUST happen before the package.json scan — when a built dist lives
  // at `apps/cli/dist/index.mjs` inside the monorepo, the scan
  // would otherwise hit `apps/cli/package.json` (name matches)
  // before reaching the repo root's `.git`, mis-classifying a dev build
  // as `global` and letting `update` run `npm i -g` against the operator's
  // real install. The two-pass split keeps source-checkout detection
  // strictly higher priority than "package on disk with our name".
  if (!inNodeModules) {
    let dir = start;
    for (let i = 0; i < 10; i++) {
      if (existsSync(resolve(dir, ".git"))) return "source";
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Pass 2: find an ancestor `package.json` whose `name` matches ours.
  let dir = start;
  for (let i = 0; i < 10; i++) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === packageName) {
          // Installed package — treat as global. `npx` also lays the tree out
          // this way, but npx caches under a path whose basename starts with
          // an underscore and lives under `_npx`. Probe for that.
          if (/\/(?:_npx|\.npm\/_npx)\//.test(dir)) return "npx";
          return "global";
        }
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "npx";
}

export type ExecuteUpdateResult =
  | { ok: true; mode: InstallMode; installedVersion: string | null }
  | {
      ok: false;
      mode: InstallMode;
      reason: string;
      /**
       * Bug 4: should the UpdateManager attempt this version again on the
       * next welcome tick? `true` for transient failures (network blips,
       * registry 5xx, killed-by-our-timeout), `false` for permanent
       * (EBADENGINE, permission, version not found).
       */
      retryable?: boolean;
      /** Stable code from the error taxonomy for log / telemetry routing. */
      reasonCode?: string;
    };

/**
 * Validate an npm install spec (the part after `@` in `<pkg>@<spec>`). We
 * accept either a known dist-tag string (`latest`, `alpha`, …) or an exact
 * SemVer version (`0.14.7`, `0.14.8-alpha.286.1`). The intent is purely
 * defensive: the spec is concatenated into the npm CLI args, and we never
 * want to forward an attacker-controlled shell metacharacter from a
 * (compromised) server welcome frame straight into `spawn`. spawn() already
 * argv-escapes, but a `--registry=...` style spec would still be
 * interpreted as an npm flag — refusing leading dashes and whitespace
 * collapses the surface unambiguously.
 */
function isSafeInstallSpec(spec: string): boolean {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > 128) return false;
  // Allow letters, digits, dot, plus, hyphen — covers every legal SemVer +
  // dist-tag. Crucially excludes whitespace, `@`, `/`, `=`, shell quotes.
  // Hyphens inside the body are fine (`0.14.8-staging.286.1`), but a
  // leading hyphen would let the spec smuggle in as an npm flag.
  if (spec.startsWith("-")) return false;
  return /^[A-Za-z0-9.+-]+$/.test(spec);
}

/** Does this spec look like a concrete SemVer (vs a dist-tag like "latest")? */
function looksLikeVersion(spec: string): boolean {
  return /^\d+\.\d+\.\d+(?:-|$)/.test(spec);
}

/**
 * Install `<pkg>@<spec>` globally. `spec` is either a dist-tag (e.g. `latest`)
 * or an exact version (e.g. `0.14.7-alpha.286.1`). Returns after the child
 * exits. Does not exit the parent process — callers are expected to handle
 * that (so the UpdateManager can attempt the restart itself while this
 * function remains side-effect-scoped).
 *
 * Why both shapes exist: the auto-update path and the default manual
 * `first-tree upgrade` command receive an exact target version from the
 * server and MUST install that exact version. The explicit
 * `first-tree upgrade --latest` escape hatch keeps the dist-tag form for
 * operators who want the freshest package directly from npm.
 */
export async function installGlobalSpec(spec: string): Promise<ExecuteUpdateResult> {
  if (!isSafeInstallSpec(spec)) {
    return {
      ok: false,
      mode: "global",
      reason: `Refusing to install: invalid npm spec ${JSON.stringify(spec)}`,
    };
  }
  // dev channel is not published — `npm install -g <null>` makes no sense.
  // Bail out before spawning npm.
  if (PACKAGE_NAME === null) {
    return {
      ok: false,
      mode: "global",
      reason: "self-update disabled: this binary's channel does not publish to npm (dev channel).",
    };
  }
  // Channel-mismatch guard: if the spec is a concrete version (not a
  // dist-tag like "latest"), refuse to install when its inferred channel
  // does not match this binary's channel. The common trigger is a server
  // server with the wrong `FIRST_TREE_CHANNEL` env — without this guard,
  // a prod CLI would auto-install a `…-staging.X.Y` build and brick its
  // service unit. Fail-closed on "unknown" predicates (`-beta.N`,
  // `-rc.N`, legacy `-alpha.N`) — extending support requires explicitly
  // teaching `inferChannelFromVersion`.
  if (looksLikeVersion(spec)) {
    const targetChannel = inferChannelFromVersion(spec);
    if (targetChannel !== channelConfig.channel) {
      const reason =
        `Refusing to install ${spec}: target channel "${targetChannel}" does not match my channel ` +
        `"${channelConfig.channel}". This usually means the First Tree server is misconfigured ` +
        `(check FIRST_TREE_CHANNEL on the server).`;
      print.line(`  [update] ${reason}\n`);
      return { ok: false, mode: "global", reason };
    }
  }
  return new Promise((resolvePromise) => {
    const npmCmd = resolveNpmCommand();
    const npmArgs = ["install", "-g", `${PACKAGE_NAME}@${spec}`];
    // Bug 4: route the subprocess through ChildProcessRegistry so it is
    // tracked and reaped by the lifecycle shutdown hook, AND give it a
    // 5-minute hard timeout (network blip on the registry used to block
    // the main process for 60s+ with no escalation). Failures are mapped
    // through the error taxonomy so UpdateManager knows whether to retry.
    const { child } = getChildProcessRegistry().spawn(npmCmd, npmArgs, {
      category: "npm-install",
      label: `npm install -g ${PACKAGE_NAME}@${spec}`,
      timeoutMs: NPM_INSTALL_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      print.line(chunk.toString("utf8"));
    });

    child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      const classification = classify(err, { source: "update" });
      resolvePromise({
        ok: false,
        mode: "global",
        reason: message,
        retryable: classification.kind === ERROR_KINDS.TRANSIENT,
        reasonCode: classification.reasonCode,
      });
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        resolvePromise({ ok: true, mode: "global", installedVersion: parseInstalledVersion(stdout) });
        return;
      }
      // Signal-terminated AND no exit code → almost certainly our 5-min
      // timeout escalation. Treat as transient so the next tick retries.
      if (code === null && signal) {
        timedOut = true;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const reason = `npm install -g ${timedOut ? `killed by signal ${signal} (timeout)` : `exited with code ${code}`}${
        stderr ? `: ${stderr.split("\n").slice(-3).join(" | ")}` : ""
      }`;
      // Classify against the stderr + code so EBADENGINE, EACCES, 404,
      // ENOTFOUND etc. each route to the right retry policy. Fall back to
      // signal-based transient when we killed it for timeout.
      const classification = timedOut
        ? { kind: ERROR_KINDS.TRANSIENT, reasonCode: "npm_timeout" as const }
        : classify(new Error(reason), { source: "update" });
      resolvePromise({
        ok: false,
        mode: "global",
        reason,
        retryable: classification.kind === ERROR_KINDS.TRANSIENT,
        reasonCode: classification.reasonCode,
      });
    });
  });
}

/**
 * Back-compat shim: install `<pkg>@latest`. Used by
 * `first-tree upgrade --latest`; managed update paths prefer
 * `installGlobalSpec` with the server-advertised target version.
 */
export async function installGlobalLatest(): Promise<ExecuteUpdateResult> {
  return installGlobalSpec("latest");
}

/**
 * Look up the server-recommended CLI version from the public bootstrap
 * config endpoint. This is the default manual-upgrade source so operators
 * follow the same rollout target as connected clients.
 */
export async function fetchServerCommandVersion(timeoutMs = 10_000): Promise<VersionLookupResult> {
  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  let res: Response;
  try {
    res = await cliFetch(`${serverUrl.replace(/\/+$/, "")}/api/v1/bootstrap/config`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    return { ok: false, reason: `server returned HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, reason: `server returned invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (body === null || typeof body !== "object") {
    return { ok: false, reason: "server returned invalid bootstrap config" };
  }

  const version = Reflect.get(body, "serverCommandVersion");
  if (typeof version !== "string" || version.length === 0) {
    return { ok: false, reason: "server did not provide serverCommandVersion" };
  }
  const normalized = semver.valid(version);
  if (!normalized) {
    return { ok: false, reason: `server returned non-semver version: ${version.slice(0, 80)}` };
  }
  return { ok: true, version: normalized };
}

/**
 * Best-effort extraction of the version npm reported as installed. npm's
 * stdout lines look like `+ first-tree@0.9.2`.
 * Returns null if nothing matches — callers treat null as "install succeeded
 * but version unknown".
 */
function parseInstalledVersion(stdout: string): string | null {
  // PACKAGE_NAME === null is unreachable here (installGlobalSpec bails
  // before spawning npm), but defend anyway so this function stays safe
  // to call standalone.
  if (PACKAGE_NAME === null) return null;
  const match = new RegExp(`${escapeForRegex(PACKAGE_NAME)}@(\\S+)`).exec(stdout);
  if (!match?.[1]) return null;
  const cleaned = match[1].replace(/[,\s)]+$/, "");
  return semver.valid(cleaned) ?? cleaned;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Look up the latest published version of the CLI package.
 *
 * Uses `npm view <pkg> version` (rather than fetch'ing registry.npmjs.org
 * directly) so the user's `.npmrc` registry, proxy, and auth settings are
 * honored — important for corporate users routed through Verdaccio /
 * Artifactory mirrors.
 */
export function fetchLatestVersion(timeoutMs = 10_000): VersionLookupResult {
  if (PACKAGE_NAME === null) {
    return { ok: false, reason: "this binary's channel does not publish to npm (dev channel)." };
  }
  const res = spawnSync(resolveNpmCommand(), ["view", PACKAGE_NAME, "version"], {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    return { ok: false, reason: stderr || `npm view exited with code ${res.status}` };
  }
  const version = (res.stdout ?? "").trim();
  if (!semver.valid(version)) {
    return { ok: false, reason: `npm view returned non-semver value: ${version.slice(0, 80)}` };
  }
  return { ok: true, version };
}
