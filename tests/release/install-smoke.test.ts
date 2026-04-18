import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = join(REPO_ROOT, "scripts");

const RUN = process.env.FIRST_TREE_RELEASE_TESTS === "1";
const d = RUN ? describe : describe.skip;

interface Harness {
  installDir: string;
  tarballPath: string;
  cli: string;
}

const cleanupDirs: string[] = [];
let harness: Harness | undefined;

function pnpmPack(outDir: string): string {
  const output = execFileSync(
    "pnpm",
    ["pack", "--pack-destination", outDir],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, FIRST_TREE_SKIP_VERSION_CHECK: "1" },
    },
  );
  const fromStdout = output.match(/([^\s]+first-tree[^\s]*\.tgz)/);
  let tarball: string | undefined;
  if (fromStdout) {
    const candidate = fromStdout[1];
    tarball = candidate.startsWith("/")
      ? candidate
      : join(outDir, candidate.replace(/^.*\//, ""));
  }
  if (!tarball || !existsSync(tarball)) {
    const entry = readdirSync(outDir).find((name) => name.endsWith(".tgz"));
    if (!entry) throw new Error("pnpm pack produced no tarball");
    tarball = join(outDir, entry);
  }
  return tarball;
}

function npmInstall(installDir: string, tarballPath: string): void {
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "first-tree-install-smoke", private: true }, null, 2),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarballPath], {
    cwd: installDir,
    encoding: "utf-8",
    env: { ...process.env, npm_config_loglevel: "error" },
    stdio: "pipe",
  });
}

function runInstalledCli(
  installDir: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const cli = join(
    installDir,
    "node_modules",
    "first-tree",
    "dist",
    "cli.js",
  );
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: installDir,
    encoding: "utf-8",
    env: { ...process.env, FIRST_TREE_SKIP_VERSION_CHECK: "1" },
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

d("tarball install smoke", () => {
  beforeAll(() => {
    const packDir = mkdtempSync(join(tmpdir(), "first-tree-pack-"));
    cleanupDirs.push(packDir);
    const tarballPath = pnpmPack(packDir);

    const installDir = mkdtempSync(join(tmpdir(), "first-tree-install-"));
    cleanupDirs.push(installDir);
    npmInstall(installDir, tarballPath);
    const cli = join(
      installDir,
      "node_modules",
      "first-tree",
      "dist",
      "cli.js",
    );
    if (!existsSync(cli)) {
      throw new Error(`Installed CLI missing at ${cli}`);
    }
    harness = { installDir, tarballPath, cli };
  }, 180_000);

  afterAll(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function installRoot(): string {
    if (!harness) throw new Error("harness not initialised");
    return join(harness.installDir, "node_modules", "first-tree");
  }

  it("reports the expected CLI version", () => {
    if (!harness) throw new Error("harness not initialised");
    const expected = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
    ) as { version: string };
    const { code, stdout } = runInstalledCli(harness.installDir, ["--version"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`first-tree=${expected.version}`);
  });

  it.each(["tree", "breeze", "gardener", "skill"])(
    "boots the %s namespace help after install",
    (ns) => {
      if (!harness) throw new Error("harness not initialised");
      const { code, stdout } = runInstalledCli(harness.installDir, [
        ns,
        "--help",
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain(`first-tree ${ns}`);
    },
  );

  it("exposes every bundled skill payload on disk", () => {
    for (const skill of ["first-tree", "tree", "breeze", "gardener"]) {
      expect(
        existsSync(join(installRoot(), "skills", skill, "SKILL.md")),
      ).toBe(true);
      expect(
        existsSync(join(installRoot(), "skills", skill, "VERSION")),
      ).toBe(true);
    }
  });

  it("ships every user-facing first-tree skill reference", () => {
    for (const ref of [
      "whitepaper",
      "onboarding",
      "principles",
      "ownership-and-naming",
      "source-workspace-installation",
      "upgrade-contract",
    ]) {
      expect(
        existsSync(
          join(
            installRoot(),
            "skills",
            "first-tree",
            "references",
            `${ref}.md`,
          ),
        ),
      ).toBe(true);
    }
  });

  it("the installed first-tree skill passes the canonical validator", () => {
    const validator = join(SCRIPTS, "quick_validate.py");
    const skillDir = join(installRoot(), "skills", "first-tree");
    const result = spawnSync("python3", [validator, skillDir], {
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
  });

  it("the installed package does not contain maintainer-only dirs", () => {
    const forbidden = [
      "tests",
      "docs",
      "evals",
      "scripts",
      ".agents",
      ".claude",
      ".github",
      ".first-tree",
    ];
    for (const name of forbidden) {
      expect(existsSync(join(installRoot(), name))).toBe(false);
    }
  });

  it("ships the tree runtime assets the CLI depends on", () => {
    expect(existsSync(join(installRoot(), "assets", "tree", "manifest.json")))
      .toBe(true);
    expect(existsSync(join(installRoot(), "assets", "tree", "VERSION"))).toBe(
      true,
    );
    expect(
      existsSync(
        join(installRoot(), "assets", "tree", "templates", "root-node.md.template"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(installRoot(), "assets", "tree", "workflows", "validate.yml"),
      ),
    ).toBe(true);
  });
});
