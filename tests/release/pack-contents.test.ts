import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const RUN = process.env.FIRST_TREE_RELEASE_TESTS === "1";
const d = RUN ? describe : describe.skip;

interface PackedTarball {
  tarballPath: string;
  entries: string[];
}

function packIntoTempDir(): PackedTarball {
  const outDir = mkdtempSync(join(tmpdir(), "first-tree-pack-"));
  const output = execFileSync(
    "pnpm",
    ["pack", "--pack-destination", outDir],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, FIRST_TREE_SKIP_VERSION_CHECK: "1" },
    },
  );
  const match = output.match(/([^\s]+first-tree[^\s]*\.tgz)/);
  let tarballPath: string | undefined;
  if (match) {
    const candidate = match[1];
    tarballPath = candidate.startsWith("/")
      ? candidate
      : join(outDir, candidate.replace(/^.*\//, ""));
  }
  if (!tarballPath || !existsSync(tarballPath)) {
    // Fall back to scanning the output directory.
    const listing = execFileSync("ls", [outDir], { encoding: "utf-8" })
      .split("\n")
      .filter((entry) => entry.endsWith(".tgz"));
    if (listing.length === 0) {
      throw new Error("pnpm pack did not produce a tarball");
    }
    tarballPath = join(outDir, listing[0]);
  }
  const entries = execFileSync("tar", ["tzf", tarballPath], {
    encoding: "utf-8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { tarballPath, entries };
}

let packed: PackedTarball | undefined;
const CLEANUP: string[] = [];

d("pnpm pack tarball", () => {
  beforeAll(() => {
    packed = packIntoTempDir();
    CLEANUP.push(dirname(packed.tarballPath));
  }, 120_000);

  afterAll(() => {
    while (CLEANUP.length > 0) {
      const dir = CLEANUP.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function entries(): string[] {
    if (!packed) throw new Error("packed is not initialised");
    return packed.entries;
  }

  function has(path: string): boolean {
    return entries().includes(`package/${path}`);
  }

  function none(matcher: (entry: string) => boolean): string[] {
    return entries().filter(matcher);
  }

  it("includes the CLI entrypoint and statusline bundle", () => {
    expect(has("dist/cli.js")).toBe(true);
    expect(has("dist/breeze-statusline.js")).toBe(true);
    expect(has("package.json")).toBe(true);
    expect(has("LICENSE")).toBe(true);
  });

  it("includes every published skill payload", () => {
    for (const skill of ["first-tree", "tree", "breeze", "gardener"]) {
      expect(has(`skills/${skill}/SKILL.md`)).toBe(true);
      expect(has(`skills/${skill}/VERSION`)).toBe(true);
    }
  });

  it("includes the first-tree skill references shipped to user repos", () => {
    for (const ref of [
      "whitepaper",
      "onboarding",
      "principles",
      "ownership-and-naming",
      "source-workspace-installation",
      "upgrade-contract",
    ]) {
      expect(has(`skills/first-tree/references/${ref}.md`)).toBe(true);
    }
  });

  it("includes tree assets required by the CLI at runtime", () => {
    expect(has("assets/tree/manifest.json")).toBe(true);
    expect(has("assets/tree/VERSION")).toBe(true);
    expect(has("assets/tree/prompts/pr-review.md")).toBe(true);
    expect(has("assets/tree/templates/root-node.md.template")).toBe(true);
    expect(has("assets/tree/templates/agents.md.template")).toBe(true);
    expect(has("assets/tree/templates/members-domain.md.template")).toBe(true);
    expect(has("assets/tree/templates/member-node.md.template")).toBe(true);
    expect(has("assets/tree/workflows/validate.yml")).toBe(true);
    expect(has("assets/tree/workflows/pr-review.yml")).toBe(true);
    expect(has("assets/tree/workflows/codeowners.yml")).toBe(true);
    expect(has("assets/tree/helpers/generate-codeowners.ts")).toBe(true);
    expect(has("assets/tree/helpers/run-review.ts")).toBe(true);
    expect(has("assets/tree/helpers/summarize-progress.js")).toBe(true);
  });

  it("includes every product VERSION file", () => {
    expect(has("src/products/tree/VERSION")).toBe(true);
    expect(has("src/products/breeze/VERSION")).toBe(true);
    expect(has("src/products/gardener/VERSION")).toBe(true);
    expect(has("src/meta/skill-tools/VERSION")).toBe(true);
  });

  it("does not ship maintainer-only directories", () => {
    const forbiddenPrefixes = [
      "package/tests/",
      "package/docs/",
      "package/evals/",
      "package/scripts/",
      "package/.agents/",
      "package/.claude/",
      "package/.github/",
      "package/first-tree-context/",
      "package/.first-tree/",
    ];
    const leaked = entries().filter((entry) =>
      forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)),
    );
    expect(leaked).toEqual([]);
  });

  it("does not ship TypeScript sources or sourcemaps from src/", () => {
    const tsLeaks = none(
      (entry) => entry.startsWith("package/src/") && entry.endsWith(".ts"),
    );
    const mapLeaks = none(
      (entry) => entry.startsWith("package/dist/") && entry.endsWith(".map"),
    );
    expect(tsLeaks).toEqual([]);
    expect(mapLeaks).toEqual([]);
  });

  it("ships dist/cli.js with a node shebang", () => {
    if (!packed) throw new Error("packed is not initialised");
    const extractDir = mkdtempSync(join(tmpdir(), "first-tree-extract-"));
    CLEANUP.push(extractDir);
    execFileSync("tar", [
      "xzf",
      packed.tarballPath,
      "-C",
      extractDir,
      "package/dist/cli.js",
    ]);
    const content = readFileSync(
      join(extractDir, "package", "dist", "cli.js"),
      "utf-8",
    );
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("bin entry in package.json matches a shipped file", () => {
    if (!packed) throw new Error("packed is not initialised");
    const extractDir = mkdtempSync(join(tmpdir(), "first-tree-extract-"));
    CLEANUP.push(extractDir);
    execFileSync("tar", [
      "xzf",
      packed.tarballPath,
      "-C",
      extractDir,
      "package/package.json",
    ]);
    const pkg = JSON.parse(
      readFileSync(join(extractDir, "package", "package.json"), "utf-8"),
    ) as { bin?: Record<string, string> };
    const binPath = pkg.bin?.["first-tree"];
    expect(binPath).toBe("dist/cli.js");
    expect(has(binPath ?? "")).toBe(true);
  });
});
