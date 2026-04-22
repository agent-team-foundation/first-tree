import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as semver from "semver";
import { print } from "./output.js";

export type InstallMode = "global" | "npx" | "source";

const PACKAGE_NAME = "@agent-team-foundation/first-tree-hub";

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
  // Walk up from argv[1] looking for either a `.git` dir (source) or a
  // `package.json` whose `name` matches ours (installed). Cap at 10 levels to
  // avoid runaway walks on exotic symlink layouts.
  let dir = dirname(resolve(argv1));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, ".git"))) return "source";
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
 * Install `<pkg>@latest` globally. Returns after the child exits. Does not
 * exit the parent process — callers are expected to handle that (so the
 * UpdateManager can attempt the restart itself while this function remains
 * side-effect-scoped).
 */
export async function installGlobalLatest(): Promise<ExecuteUpdateResult> {
  return new Promise((resolvePromise) => {
    const npmCmd = resolveNpmCommand();
    const npmArgs = ["install", "-g", `${PACKAGE_NAME}@latest`];
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
