import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the multi-env P0 / B2 footgun:
 *
 *     export const X = join(defaultHome(), "...");           // ← BANNED (top-level const)
 *     export const Y = defaultConfigDir();                   // ← BANNED (top-level const)
 *     field(z.string().default(join(defaultDataDir(), …)))   // ← BANNED (zod default eager-evaluates at schema definition)
 *
 * Any expression that calls `defaultHome()` / `defaultConfigDir()` /
 * `defaultDataDir()` at module load (whether captured into a const, or
 * passed as a value to something that evaluates eagerly like a zod
 * `.default(...)` expression) locks the value to the prod fallback on
 * the CLI side. After tsdown bundles the workspace, every chunk's
 * top-level evaluation runs BEFORE the importing CLI entry's body —
 * so the `channel-env.ts` side-effect that sets `FIRST_TREE_HOME` from
 * `channelConfig.defaultHome` has not run yet. Resolves to
 * `~/.first-tree` (prod fallback), silently breaking multi-env
 * isolation for staging and dev users.
 *
 * The two regexes below cover the two shapes seen in the original
 * incident. Future shapes (e.g. `Object.defineProperty(globalThis, "X",
 * { value: defaultHome() })`) would still need a parser-based guard,
 * but the docblock in `resolver.ts` warns against ALL top-level uses
 * so a code reviewer should catch novel forms.
 *
 * History:
 *   - PR `feat/multi-env-isolation` (May 2026), review pass 1:
 *     env-set-early simplification broke after bundle hoist.
 *     resolver.ts const → function.
 *   - Same PR review pass 2 (B2): `apps/cli/src/core/onboard.ts`
 *     STATE_FILE missed. Caught by manual grep, prompted this test.
 *   - Same PR review pass 3 (external reviewer): pointed out the test
 *     missed the `field(z.*.default(...default*()))` zod-default shape
 *     (server-config.ts:56 was the example). Added second regex below.
 *
 * The check is purely textual — it doesn't load any modules. Fast and
 * side-effect-free.
 *
 * Scope: scans `apps/` and `packages/` (the channel-aware tree), which
 * includes `packages/server/` and `packages/shared/`. Server-only code
 * (e.g. `server-config.ts`) does not hit the bundle-hoist bug at
 * runtime — server runs from its own dist without channel-env — but
 * the eager evaluation is still a smell and gets flagged uniformly.
 * If a real false positive ever appears, this docblock is the right
 * place to extend the exclusion list, not silently per-file allow.
 */

const REPO_ROOT = resolve(__dirname, "../../../..");

const SCAN_ROOTS: ReadonlyArray<string> = ["apps", "packages"];

const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", ".turbo", ".git"]);

const FILE_EXTS = [".ts", ".tsx"] as const;

// Shape A: top-level `[export] const NAME = ...default*()`.
// Anchors at column 0 of any line (multiline flag), so call sites
// inside function bodies (indented) are ignored.
const TOPLEVEL_CONST_RE = /^(?:export\s+)?const\s+\w+\s*=\s*(?:join\(\s*)?default(?:Home|ConfigDir|DataDir)\(\)/m;

// Shape B: zod schema default evaluating eagerly at schema-definition
// time, e.g. `field(z.string().default(join(defaultDataDir(), "x")))`.
// Match `.default(...)` where the argument expression contains a
// `default(Home|ConfigDir|DataDir)()` call. Non-greedy across single
// line to keep it simple — multi-line schema defaults would need a
// parser anyway.
const ZOD_DEFAULT_RE = /\.default\([^)]*default(?:Home|ConfigDir|DataDir)\(\)/;

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

describe("regression guard: no module-load eager evaluation of default*Dir()", () => {
  it("scans apps/ and packages/ for the multi-env footgun (two shapes)", () => {
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

    const topLevelConstOffenders: string[] = [];
    const zodDefaultOffenders: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      const rel = relative(REPO_ROOT, path).split(sep).join("/");
      if (TOPLEVEL_CONST_RE.test(text)) topLevelConstOffenders.push(rel);
      if (ZOD_DEFAULT_RE.test(text)) zodDefaultOffenders.push(rel);
    }

    expect(
      topLevelConstOffenders,
      "top-level const(s) derived from default*Dir() — bundle hoist will lock these to the prod fallback. " +
        "Replace with a function (see service-install.ts logDir / onboard.ts stateFile for the pattern).",
    ).toEqual([]);

    expect(
      zodDefaultOffenders,
      "zod `.default(...)` argument evaluates default*Dir() at schema-definition time — same module-load " +
        "footgun as the top-level const form. Wrap the default in a function: " +
        "`field(z.string().default(() => join(defaultDataDir(), '...')))`.",
    ).toEqual([]);
  });
});
