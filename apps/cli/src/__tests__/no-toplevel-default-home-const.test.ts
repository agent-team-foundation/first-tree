import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the multi-env P0 / B2 footgun:
 *
 *     export const X = join(defaultHome(), "...");      // ← BANNED
 *     export const Y = defaultConfigDir();              // ← BANNED
 *     const Z = defaultDataDir();                       // ← BANNED at top level
 *
 * Top-level `const`s that capture `defaultHome()` / `defaultConfigDir()`
 * / `defaultDataDir()` return values evaluate at module load. After
 * tsdown bundles the workspace, every chunk's top-level evaluation runs
 * BEFORE the importing CLI entry's body — so the `channel-env.ts`
 * side-effect that sets `FIRST_TREE_HOME` from `channelConfig.defaultHome`
 * has not run yet. The captured value locks to the prod fallback
 * (`~/.first-tree`), silently breaking multi-env isolation for staging
 * and dev users.
 *
 * History:
 *   - PR `feat/multi-env-isolation` (May 2026), review pass 1: the original
 *     design used env-set-early instead of function-ization. Bundle eval
 *     order broke it. resolver.ts const → function.
 *   - Same PR review pass 2 (B2): `apps/cli/src/core/onboard.ts` STATE_FILE
 *     was missed during the sweep — same shape, same outcome. Caught by
 *     manual grep, not by tests. This file is the regression guard so
 *     the third pass never happens.
 *
 * The check is purely textual (regex) — it doesn't load any modules.
 * That keeps it fast and side-effect-free.
 */

const REPO_ROOT = resolve(__dirname, "../../../..");

const SCAN_ROOTS: ReadonlyArray<string> = ["apps", "packages"];

const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", ".turbo", ".git"]);

const FILE_EXTS = [".ts", ".tsx"] as const;

// Match top-level (zero-indent) `[export] const NAME = ...default*()`.
// `default*` covers `defaultHome` / `defaultConfigDir` / `defaultDataDir`.
// Multiline flag lets the regex anchor on each line of the file.
const OFFENDER_RE = /^(?:export\s+)?const\s+\w+\s*=\s*(?:join\(\s*)?default(?:Home|ConfigDir|DataDir)\(\)/m;

function walk(dir: string, files: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const ent of entries) {
    const name = ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(join(dir, name), files);
      continue;
    }
    if (!ent.isFile()) continue;
    if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
    if (!FILE_EXTS.some((ext) => name.endsWith(ext))) continue;
    files.push(join(dir, name));
  }
}

describe("regression guard: no top-level const captures default*Dir() return value", () => {
  it("scans apps/ and packages/ for the multi-env footgun", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      const abs = join(REPO_ROOT, root);
      try {
        statSync(abs);
      } catch {
        continue;
      }
      walk(abs, files);
    }
    expect(files.length, "scan found no source files — REPO_ROOT may be wrong").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      if (OFFENDER_RE.test(text)) {
        offenders.push(relative(REPO_ROOT, path).split(sep).join("/"));
      }
    }

    expect(
      offenders,
      "top-level const(s) derived from default*Dir() — bundle hoist will lock these to the prod fallback. " +
        "Replace with a function (see service-install.ts logDir / onboard.ts stateFile for the pattern).",
    ).toEqual([]);
  });
});
