import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as semver from "semver";
import { print } from "./output.js";

export type InstallMode = "global" | "npx" | "source";

export const PACKAGE_NAME = "@agent-team-foundation/first-tree-hub";

/**
 * Pick the `npm` binary to invoke for self-update. Background service units
 * hard-code a minimal PATH (/usr/local/bin, /opt/homebrew/bin, /usr/bin,
 * /bin) that misses nvm / asdf / Volta toolchain directories — the client
 * launches fine from an absolute path resolved at install time, but a plain
 * `spawn("npm")` then ENOENTs. Node and npm always ship side-by-side, so
 * `dirname(execPath)/npm` is the most reliable fallback across those
 * managers; if the sibling is missing (e.g. corporate custom layout) we
 * fall back to PATH lookup.
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
 *    reinstalls the same package at `@latest`.
 *  - `"source"`: launched from inside a git checkout (dev / monorepo). Update
 *    is a no-op; operator should `git pull`.
 *  - `"npx"` (fallback): any other path (e.g. one-shot `npx`, pnpm dlx). Auto
 *    update is not safe; log a hint and skip.
 */
export function detectInstallMode(argv1: string = process.argv[1] ?? ""): InstallMode {
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
        if (pkg.name === PACKAGE_NAME) {
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
  | { ok: false; mode: InstallMode; reason: string };

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
  // Hyphens inside the body are fine (`0.14.8-alpha.286.1`), but a leading
  // hyphen would let the spec smuggle in as an npm flag.
  if (spec.startsWith("-")) return false;
  return /^[A-Za-z0-9.+-]+$/.test(spec);
}

/**
 * Install `<pkg>@<spec>` globally. `spec` is either a dist-tag (e.g. `latest`)
 * or an exact version (e.g. `0.14.7-alpha.286.1`). Returns after the child
 * exits. Does not exit the parent process — callers are expected to handle
 * that (so the UpdateManager can attempt the restart itself while this
 * function remains side-effect-scoped).
 *
 * Why both shapes exist: the auto-update path receives `targetVersion` from
 * the server `welcome` frame and MUST install that exact version — using
 * `@latest` from auto-update would silently mis-resolve once the server
 * starts advertising alpha builds (alpha lives on a different dist-tag).
 * The manual `first-tree-hub update` CLI keeps the dist-tag form so users
 * who type the command without args still get "newest stable on npm".
 */
export async function installGlobalSpec(spec: string): Promise<ExecuteUpdateResult> {
  if (!isSafeInstallSpec(spec)) {
    return {
      ok: false,
      mode: "global",
      reason: `Refusing to install: invalid npm spec ${JSON.stringify(spec)}`,
    };
  }
  return new Promise((resolvePromise) => {
    const npmCmd = resolveNpmCommand();
    const npmArgs = ["install", "-g", `${PACKAGE_NAME}@${spec}`];
    const child = spawn(npmCmd, npmArgs, { stdio: ["ignore", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      print.line(chunk.toString("utf8"));
    });

    child.on("error", (err) => {
      resolvePromise({ ok: false, mode: "global", reason: err instanceof Error ? err.message : String(err) });
    });

    child.on("exit", (code) => {
      if (code === 0) {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        resolvePromise({ ok: true, mode: "global", installedVersion: parseInstalledVersion(stdout) });
      } else {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        resolvePromise({
          ok: false,
          mode: "global",
          reason: `npm install -g exited with code ${code}${stderr ? `: ${stderr.split("\n").slice(-3).join(" | ")}` : ""}`,
        });
      }
    });
  });
}

/**
 * Back-compat shim: install `<pkg>@latest`. The manual `first-tree-hub
 * update` CLI uses this so an operator-typed `update` keeps the
 * "newest stable on npm" behaviour. Auto-update prefers `installGlobalSpec`
 * with the welcome frame's `targetVersion`.
 */
export async function installGlobalLatest(): Promise<ExecuteUpdateResult> {
  return installGlobalSpec("latest");
}

/**
 * Best-effort extraction of the version npm reported as installed. npm's
 * stdout lines look like `+ @agent-team-foundation/first-tree-hub@0.9.2`.
 * Returns null if nothing matches — callers treat null as "install succeeded
 * but version unknown".
 */
function parseInstalledVersion(stdout: string): string | null {
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
export function fetchLatestVersion(timeoutMs = 10_000): { ok: true; version: string } | { ok: false; reason: string } {
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
