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
import { USAGE, isDirectExecution, runCli } from "../../../src/cli.ts";

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
  it("documents the dedicated-repo meaning of --here", () => {
    expect(USAGE).toContain("git init && first-tree init --here");
    expect(USAGE).toContain("first-tree init --seed-members contributors");
    expect(USAGE).toContain("first-tree publish --open-pr");
    expect(USAGE).toContain("my-org-tree");
    expect(USAGE).toContain("`--here` is for when the current repo is already the dedicated tree repo.");
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

  it("prints the package version", async () => {
    const output = captureOutput();
    const pkgPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

    const code = await runCli(["--version"], output.write);

    expect(code).toBe(0);
    expect(output.lines).toEqual([pkg.version]);
  });

  it("routes help onboarding through the CLI entrypoint", async () => {
    const output = captureOutput();

    const code = await runCli(["help", "onboarding"], output.write);

    expect(code).toBe(0);
    expect(output.lines.join("\n")).toContain("# Context Tree Onboarding");
    expect(output.lines.join("\n")).toContain("Node.js 18+");
  });

  it("fails with usage for an unknown command", async () => {
    const output = captureOutput();

    const code = await runCli(["wat"], output.write);

    expect(code).toBe(1);
    expect(output.lines[0]).toBe("Unknown command: wat");
    expect(output.lines[1]).toBe(USAGE);
  });
});
