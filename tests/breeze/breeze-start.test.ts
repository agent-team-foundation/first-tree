/**
 * Unit tests for the breeze `start` command's argv wiring.
 *
 * Regression for the bug where `runStart` defaulted `executable` to
 * `process.execPath` (node) while `defaultDaemonArgs` started the
 * argument list with `"breeze"` — launchd then tried to exec
 * `node breeze daemon ...` and failed with `Cannot find module '/breeze'`.
 * The fix points launchd at the `first-tree` bin directly (it carries a
 * `#!/usr/bin/env node` shebang) and keeps the subcommand argv as the
 * bin's own argv[2:].
 */

import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultDaemonArgs,
  resolveDefaultExecutable,
} from "../../src/products/breeze/engine/commands/start.js";

describe("defaultDaemonArgs", () => {
  it("prepends the `breeze daemon --backend=ts` dispatch triple", () => {
    expect(defaultDaemonArgs([])).toEqual([
      "breeze",
      "daemon",
      "--backend=ts",
    ]);
  });

  it("forwards unknown flags like --allow-repo through to the daemon", () => {
    expect(
      defaultDaemonArgs([
        "--allow-repo",
        "bingran-you/breeze-smoke,agent-team-foundation/first-tree",
      ]),
    ).toEqual([
      "breeze",
      "daemon",
      "--backend=ts",
      "--allow-repo",
      "bingran-you/breeze-smoke,agent-team-foundation/first-tree",
    ]);
  });

  it("drops --home/--profile (plus their values) since runStart handles them locally", () => {
    expect(
      defaultDaemonArgs([
        "--home",
        "/tmp/breeze",
        "--profile",
        "ci",
        "--allow-repo=owner/repo",
      ]),
    ).toEqual([
      "breeze",
      "daemon",
      "--backend=ts",
      "--allow-repo=owner/repo",
    ]);
  });

  it("also drops --home=... and --profile=... equals forms", () => {
    expect(
      defaultDaemonArgs([
        "--home=/tmp/breeze",
        "--profile=ci",
        "--allow-repo=owner/repo",
      ]),
    ).toEqual([
      "breeze",
      "daemon",
      "--backend=ts",
      "--allow-repo=owner/repo",
    ]);
  });

  it("does not emit `node` or any script-path placeholder in the first slot (regression: launchd plist was `node breeze ...`)", () => {
    const args = defaultDaemonArgs([]);
    expect(args[0]).toBe("breeze");
    expect(args).not.toContain("node");
    expect(args[0]).not.toMatch(/\.js$/);
  });
});

describe("resolveDefaultExecutable", () => {
  it("returns the realpath of the given argv[1] (resolves symlinks)", () => {
    const tmp = realpathSync(
      mkdtempSync(join(tmpdir(), "breeze-start-exec-")),
    );
    const target = join(tmp, "first-tree.js");
    const link = join(tmp, "first-tree");
    writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
    symlinkSync(target, link);
    try {
      expect(resolveDefaultExecutable(link)).toBe(target);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns the raw path when realpath fails (e.g. nonexistent)", () => {
    const ghost = "/does/not/exist/first-tree";
    expect(resolveDefaultExecutable(ghost)).toBe(ghost);
  });

  it("throws a clear error when argv[1] is empty/unset", () => {
    // Empty string skips the `= process.argv[1]` default so we can exercise
    // the "nothing to resolve" branch deterministically under vitest.
    expect(() => resolveDefaultExecutable("")).toThrow(
      /process\.argv\[1\] is unset/,
    );
  });
});
