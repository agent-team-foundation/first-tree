import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE, isDirectExecution, runCli, stripGlobalFlags } from "../src/cli.js";
import { TREE_USAGE } from "../src/products/tree/cli.js";

const TEMP_DIRS: string[] = [];

function captureOutput(): { lines: string[]; write: (text: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    write: (text: string) => {
      lines.push(text);
    },
  };
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "first-tree-thin-cli-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("thin CLI shell", () => {
  it("exposes both product namespaces in the top-level USAGE", () => {
    expect(USAGE).toContain("first-tree <product>");
    expect(USAGE).toContain("tree");
    expect(USAGE).toContain("breeze");
    expect(USAGE).toContain("--skip-version-check");
    expect(USAGE).toContain("--version");
  });

  it("documents tree commands in the tree USAGE", () => {
    expect(TREE_USAGE).toContain("first-tree tree init tree --here");
    expect(TREE_USAGE).toContain(
      "first-tree tree init --tree-path ../org-context --tree-mode shared",
    );
    expect(TREE_USAGE).toContain("first-tree tree publish --tree-path ../org-context");
    expect(TREE_USAGE).toContain("my-org-tree");
    expect(TREE_USAGE).toContain(
      "`first-tree tree init tree --here` is for when the current repo is already the tree repo.",
    );
    expect(TREE_USAGE).toContain("review");
    expect(TREE_USAGE).toContain("generate-codeowners");
    expect(TREE_USAGE).toContain("inject-context");
  });

  it("treats a symlinked npm bin path as direct execution", () => {
    const dir = makeTempDir();
    const target = join(dir, "cli.js");
    const symlinkPath = join(dir, "first-tree");

    writeFileSync(target, "#!/usr/bin/env node\n");
    symlinkSync(target, symlinkPath);

    expect(isDirectExecution(symlinkPath, pathToFileURL(target).href)).toBe(true);
  });

  it("does not treat unrelated argv[1] values as direct execution", () => {
    const dir = makeTempDir();
    const target = join(dir, "cli.js");
    const other = join(dir, "other.js");

    writeFileSync(target, "#!/usr/bin/env node\n");
    writeFileSync(other, "#!/usr/bin/env node\n");

    expect(isDirectExecution(other, pathToFileURL(target).href)).toBe(false);
    expect(isDirectExecution(undefined, pathToFileURL(target).href)).toBe(false);
  });

  it("prints usage with no args", async () => {
    const output = captureOutput();

    const code = await runCli([], output.write);

    expect(code).toBe(0);
    expect(output.lines).toEqual([USAGE]);
  });

  it("prints the CLI version plus one version per product in the manifest", async () => {
    const output = captureOutput();
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    const productVersion = (name: string): string => {
      const versionPath = fileURLToPath(
        new URL(`../src/products/${name}/VERSION`, import.meta.url),
      );
      return readFileSync(versionPath, "utf-8").trim();
    };

    const code = await runCli(["--version"], output.write);

    expect(code).toBe(0);
    expect(output.lines).toEqual([
      [
        `first-tree=${pkg.version}`,
        `tree=${productVersion("tree")}`,
        `breeze=${productVersion("breeze")}`,
        `gardener=${productVersion("gardener")}`,
        `skill=${productVersion("skill")}`,
      ].join(" "),
    ]);
  });

  it("routes tree help onboarding through the CLI entrypoint", async () => {
    const output = captureOutput();

    const code = await runCli(
      ["--skip-version-check", "tree", "help", "onboarding"],
      output.write,
    );

    expect(code).toBe(0);
    expect(output.lines.join("\n")).toContain("# Context Tree Onboarding");
    expect(output.lines.join("\n")).toContain("Node.js 18+");
  });

  it("fails with hint for an unknown product", async () => {
    const output = captureOutput();

    const code = await runCli(
      ["--skip-version-check", "wat"],
      output.write,
    );

    expect(code).toBe(1);
    expect(output.lines[0]).toBe("Unknown product: wat");
    expect(output.lines[1]).toContain("first-tree tree wat");
  });

  it("fails with tree USAGE for an unknown tree command", async () => {
    const output = captureOutput();

    const code = await runCli(
      ["--skip-version-check", "tree", "nonsense"],
      output.write,
    );

    expect(code).toBe(1);
    expect(output.lines[0]).toBe("Unknown command: nonsense");
    expect(output.lines[1]).toBe(TREE_USAGE);
  });

  it("strips --skip-version-check from args before dispatch", () => {
    const result = stripGlobalFlags([
      "--skip-version-check",
      "tree",
      "init",
      "--here",
    ]);
    expect(result.skipVersionCheck).toBe(true);
    expect(result.rest).toEqual(["tree", "init", "--here"]);
  });

  it("strips --skip-version-check from positional position", () => {
    const result = stripGlobalFlags([
      "tree",
      "init",
      "--skip-version-check",
      "--here",
    ]);
    expect(result.skipVersionCheck).toBe(true);
    expect(result.rest).toEqual(["tree", "init", "--here"]);
  });

  it("returns false when --skip-version-check is absent", () => {
    const result = stripGlobalFlags(["tree", "init", "--here"]);
    expect(result.skipVersionCheck).toBe(false);
    expect(result.rest).toEqual(["tree", "init", "--here"]);
  });

  it("routes tree inject-context command", async () => {
    const output = captureOutput();
    const code = await runCli(
      ["--skip-version-check", "tree", "inject-context", "--help"],
      output.write,
    );
    expect(code).toBe(0);
  });

  it("routes tree generate-codeowners command", async () => {
    const output = captureOutput();
    const code = await runCli(
      ["--skip-version-check", "tree", "generate-codeowners", "--help"],
      output.write,
    );
    expect(code).toBe(0);
  });

  it("routes tree review command", async () => {
    const output = captureOutput();
    const code = await runCli(
      ["--skip-version-check", "tree", "review", "--help"],
      output.write,
    );
    expect(code).toBe(0);
  });

  it("breeze product prints breeze USAGE for --help", async () => {
    const output = captureOutput();
    const code = await runCli(
      ["--skip-version-check", "breeze", "--help"],
      output.write,
    );
    expect(code).toBe(0);
    expect(output.lines.join("\n")).toContain("usage: first-tree breeze");
    expect(output.lines.join("\n")).toContain("run-once");
  });

  it("breeze product fails with hint for unknown subcommand", async () => {
    const output = captureOutput();
    const code = await runCli(
      ["--skip-version-check", "breeze", "no-such-thing"],
      output.write,
    );
    expect(code).toBe(1);
    expect(output.lines[0]).toBe("Unknown breeze command: no-such-thing");
  });
});
