import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(testDir, "..");
const repoRoot = resolve(cliRoot, "../..");
const entryPath = resolve(cliRoot, "dist/index.js");
const rootPackagePath = resolve(repoRoot, "package.json");
const cliPackagePath = resolve(cliRoot, "package.json");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runCli(args) {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [entryPath, ...args],
      { cwd: repoRoot },
      (error, stdout, stderr) => {
        resolveRun({
          code: error && "code" in error ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

describe("first-tree CLI", () => {
  it("prints the workspace package version", async () => {
    const rootPackage = await readJson(rootPackagePath);
    const cliPackage = await readJson(cliPackagePath);
    const result = await runCli(["--version"]);

    expect(cliPackage.version).toBe(rootPackage.version);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(rootPackage.version);
  });

  it("prints help with the init command", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree");
    expect(result.stdout).toContain("CLI for initializing and maintaining first-tree context trees.");
    expect(result.stdout).toContain("init");
  });

  it("runs the init placeholder successfully", async () => {
    const result = await runCli(["init"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("first-tree init is not implemented yet.");
  });

  it("keeps a shebang on the compiled entry", async () => {
    const entrySource = await readFile(entryPath, "utf8");

    expect(entrySource.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("runs through a bin-style symlink", async () => {
    const rootPackage = await readJson(rootPackagePath);
    const tempDir = await mkdtemp(resolve(tmpdir(), "first-tree-bin-"));
    const binPath = resolve(tempDir, "first-tree");

    try {
      await symlink(entryPath, binPath);

      const result = await new Promise((resolveRun) => {
        execFile(
          process.execPath,
          [binPath, "--version"],
          { cwd: repoRoot },
          (error, stdout, stderr) => {
            resolveRun({
              code: error && "code" in error ? error.code : 0,
              stdout,
              stderr,
            });
          },
        );
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(rootPackage.version);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("exposes first-tree and ft bins through the compiled entry", async () => {
    const cliPackage = await readJson(cliPackagePath);

    expect(cliPackage.bin).toEqual({
      "first-tree": "./dist/index.js",
      ft: "./dist/index.js",
    });
  });
});
