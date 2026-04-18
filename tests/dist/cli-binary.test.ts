import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.FIRST_TREE_DIST_TESTS === "1";
const d = RUN ? describe : describe.skip;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(REPO_ROOT, "dist");
const CLI = join(DIST, "cli.js");
const STATUSLINE = join(DIST, "breeze-statusline.js");

function readPkgVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
  ) as { version: string; bin?: Record<string, string> };
  return pkg.version;
}

function runNode(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...opts.env, FIRST_TREE_SKIP_VERSION_CHECK: "1" },
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

d("dist/cli.js", () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(
        `dist/cli.js missing. Run 'pnpm build' before 'pnpm test:dist'.`,
      );
    }
  });

  it("declares the expected bin entry in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
    ) as { bin?: Record<string, string> };
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin?.["first-tree"]).toBe("dist/cli.js");
    expect(existsSync(join(REPO_ROOT, pkg.bin?.["first-tree"] ?? ""))).toBe(
      true,
    );
  });

  it("reports a version string that contains the package.json version", () => {
    const { code, stdout } = runNode([CLI, "--version"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`first-tree=${readPkgVersion()}`);
  });

  it("shows the top-level usage with all four namespaces", () => {
    const { code, stdout } = runNode([CLI, "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("first-tree <namespace>");
    for (const ns of ["tree", "breeze", "gardener", "skill"]) {
      expect(stdout).toContain(ns);
    }
  });

  it.each(["tree", "breeze", "gardener", "skill"])(
    "boots the %s namespace help without error",
    (ns) => {
      const { code, stdout } = runNode([CLI, ns, "--help"]);
      expect(code).toBe(0);
      expect(stdout).toContain(`first-tree ${ns}`);
    },
  );

  it("exits non-zero on an unknown namespace", () => {
    const { code } = runNode([CLI, "not-a-namespace"]);
    expect(code).not.toBe(0);
  });
});

d("dist/breeze-statusline.js", () => {
  beforeAll(() => {
    if (!existsSync(STATUSLINE)) {
      throw new Error(
        `dist/breeze-statusline.js missing. Run 'pnpm build' first.`,
      );
    }
  });

  it("is emitted as an independent bundle", () => {
    const size = statSync(STATUSLINE).size;
    expect(size).toBeGreaterThan(0);
  });

  it("executes and exits within the statusline latency budget", () => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [STATUSLINE], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      input: JSON.stringify({ cwd: REPO_ROOT }),
      env: { ...process.env, FIRST_TREE_SKIP_VERSION_CHECK: "1" },
      timeout: 5_000,
    });
    const duration = Date.now() - started;
    expect(result.status ?? 1).toBe(0);
    expect(duration).toBeLessThan(2_000);
  });
});

d("dist bundle integrity", () => {
  it("does not reference the TypeScript sources", () => {
    const entries = readdirSync(DIST);
    for (const entry of entries) {
      if (!entry.endsWith(".js")) continue;
      const content = readFileSync(join(DIST, entry), "utf-8");
      expect(
        content.includes("../src/") || content.includes("/src/products/"),
        `${entry} still references the src/ tree`,
      ).toBe(false);
    }
  });

  it("package.json files allowlist includes the dist folder", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
    ) as { files?: string[] };
    expect(pkg.files).toContain("dist");
  });
});
