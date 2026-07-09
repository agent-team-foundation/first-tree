import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");

function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

function readJson(path: string): unknown {
  return JSON.parse(readText(path));
}

function packageFiles(value: unknown): string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    !value.files.every((entry) => typeof entry === "string")
  ) {
    throw new Error("apps/cli/package.json must declare a string[] files list");
  }
  return value.files;
}

describe("npm package metadata", () => {
  it("includes package-root documentation and license files in the tarball allow-list", () => {
    const files = packageFiles(readJson(join(CLI_ROOT, "package.json")));

    expect(files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
  });

  it("keeps a package-local README for the npm registry page", () => {
    const readmePath = join(CLI_ROOT, "README.md");

    expect(existsSync(readmePath)).toBe(true);

    const readme = readText(readmePath);

    expect(readme).toContain("npm install -g first-tree");
    expect(readme).toContain("first-tree login <connect-code>");
    expect(readme).toContain("https://github.com/agent-team-foundation/first-tree/blob/main/docs/cli-reference.md");
    expect(readme).toContain("Apache-2.0");
  });

  it("ships the Apache-2.0 license text at the package root", () => {
    const licensePath = join(CLI_ROOT, "LICENSE");

    expect(existsSync(licensePath)).toBe(true);
    expect(readText(licensePath)).toBe(readText(join(REPO_ROOT, "LICENSE")));
    expect(readText(licensePath)).toContain("Apache License");
    expect(readText(licensePath)).toContain("Version 2.0, January 2004");
  });
});
