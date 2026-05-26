import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelConfig } from "../core/channel.js";
import { resolveCommandVersion } from "../core/version.js";

// Walk target = channelConfig.packageName ?? binName. In the source tree
// (CHANNEL=dev) this is "first-tree-dev"; after CI rewrites for prod /
// staging it becomes "first-tree" / "first-tree-staging".
const PACKAGE_NAME = channelConfig.packageName ?? channelConfig.binName;

describe("resolveCommandVersion", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ftHub-version-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Dev layout: `tsx src/cli/index.ts` runs source files, so this module
  // resolves from `apps/cli/src/core/version.ts` and must walk up
  // two levels to `apps/cli/package.json`.
  it("reads the version from the dev-source layout (two levels up)", () => {
    const pkgDir = join(root, "packages", "command");
    const moduleDir = join(pkgDir, "src", "core");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "9.9.9" }));
    const moduleUrl = pathToFileURL(join(moduleDir, "version.ts")).href;
    expect(resolveCommandVersion(moduleUrl)).toBe("9.9.9");
  });

  // Bundled layout that v0.9.1 shipped: tsdown flattens `src/core/version.ts`
  // into `dist/core-*.mjs`, so the module resolves only one level up from
  // its `package.json`. The old `require("../../package.json")` looked two
  // levels up and crashed — this test pins the fix.
  it("reads the version from the bundled dist layout (one level up)", () => {
    const pkgDir = join(root, "node_modules", PACKAGE_NAME);
    const distDir = join(pkgDir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "0.9.2" }));
    const moduleUrl = pathToFileURL(join(distDir, "core-abc123.mjs")).href;
    expect(resolveCommandVersion(moduleUrl)).toBe("0.9.2");
  });

  // Bundled CLI entry lives one directory deeper than the `core-*.mjs`
  // chunk, so double-check the walk doesn't stop at the wrong level.
  it("reads the version from dist/cli/index.mjs (two levels up)", () => {
    const pkgDir = join(root, "node_modules", PACKAGE_NAME);
    const cliDir = join(pkgDir, "dist", "cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "1.2.3" }));
    const moduleUrl = pathToFileURL(join(cliDir, "index.mjs")).href;
    expect(resolveCommandVersion(moduleUrl)).toBe("1.2.3");
  });

  // A sibling `package.json` belonging to a different workspace package (or
  // a parent-monorepo root) must be skipped so the walker keeps going up.
  it("skips package.json entries whose name does not match", () => {
    const monoRoot = join(root, "mono");
    const pkgDir = join(monoRoot, "packages", "command");
    const moduleDir = join(pkgDir, "dist");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(monoRoot, "package.json"), JSON.stringify({ name: "mono-root", version: "0.0.1" }));
    writeFileSync(
      join(monoRoot, "packages", "package.json"),
      JSON.stringify({ name: "packages-shim", version: "0.0.1" }),
    );
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "5.5.5" }));
    const moduleUrl = pathToFileURL(join(moduleDir, "core.mjs")).href;
    expect(resolveCommandVersion(moduleUrl)).toBe("5.5.5");
  });

  // Fallback when nothing matches — must return "unknown" (deliberately not
  // valid SemVer so the client UpdateManager's `semver.valid(current)` check
  // routes to warn-and-skip instead of `semver.lt("0.0.0", target) === true`
  // triggering a spurious auto-update loop).
  it("falls back to 'unknown' when no matching package.json is found", () => {
    const stray = join(root, "stray");
    mkdirSync(stray, { recursive: true });
    const moduleUrl = pathToFileURL(join(stray, "module.mjs")).href;
    expect(resolveCommandVersion(moduleUrl)).toBe("unknown");
  });

  // Skips malformed JSON without crashing, and surfaces a stderr warning so
  // an operator can tell the walker found something unusual (rather than
  // silently degrading to the fallback).
  it("warns on malformed JSON but keeps walking", () => {
    const pkgDir = join(root, "packages", "command");
    const moduleDir = join(pkgDir, "dist");
    const parentDir = root;
    mkdirSync(moduleDir, { recursive: true });
    // Closer (wrong) manifest is malformed; correct manifest sits higher up.
    writeFileSync(join(pkgDir, "package.json"), "{not valid json");
    writeFileSync(join(parentDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "7.7.7" }));

    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const moduleUrl = pathToFileURL(join(moduleDir, "core.mjs")).href;
      expect(resolveCommandVersion(moduleUrl)).toBe("7.7.7");
      expect(warn).toHaveBeenCalled();
      const firstCall = warn.mock.calls[0]?.[0];
      expect(typeof firstCall === "string" ? firstCall : "").toMatch(/could not read/);
    } finally {
      warn.mockRestore();
    }
  });

  // Permission-denied (EACCES) on an intermediate manifest must warn but not
  // abort the walk: the v0.9.1 startup-crash regression this module avoids
  // hinges on NEVER throwing from module load. Skip on platforms that don't
  // honour chmod 000 (Windows).
  it.skipIf(process.platform === "win32")("warns on EACCES but keeps walking", () => {
    const pkgDir = join(root, "packages", "command");
    const moduleDir = join(pkgDir, "dist");
    mkdirSync(moduleDir, { recursive: true });
    const lockedPkg = join(pkgDir, "package.json");
    writeFileSync(lockedPkg, JSON.stringify({ name: PACKAGE_NAME, version: "8.8.8" }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "6.6.6" }));
    chmodSync(lockedPkg, 0o000);

    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const moduleUrl = pathToFileURL(join(moduleDir, "core.mjs")).href;
      // Locked manifest is unreadable, so the walker falls through to the
      // grand-parent manifest. Either outcome is acceptable; what matters is
      // that the function does not throw and that it surfaces a warning.
      const result = resolveCommandVersion(moduleUrl);
      expect(["6.6.6", "unknown"]).toContain(result);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      // Restore perms so afterEach's rmSync can clean up.
      chmodSync(lockedPkg, 0o644);
    }
  });
});
