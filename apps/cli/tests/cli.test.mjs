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
const commandNames = ["init", "tree", "hub", "breeze", "gardener"];
const rootHelpCommandPaths = [
  "first-tree init",
  "first-tree tree inspect",
  "first-tree hub start",
  "first-tree breeze poll",
  "first-tree gardener sync",
];
const commandGroups = [
  {
    name: "tree",
    subcommands: ["inspect", "status", "generate-codeowners", "install-claude-code-hook"],
  },
  {
    name: "hub",
    subcommands: ["start", "stop", "doctor", "status"],
  },
  {
    name: "breeze",
    subcommands: ["install", "start", "stop", "status", "doctor", "poll"],
  },
  {
    name: "gardener",
    subcommands: ["sync", "status", "install"],
  },
];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runCli(args) {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [entryPath, ...args], { cwd: repoRoot }, (error, stdout, stderr) => {
      resolveRun({
        code: error && "code" in error ? error.code : 0,
        stdout,
        stderr,
      });
    });
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

  it("prints help with registered commands", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree");
    expect(result.stdout).toContain(
      "CLI for initializing and maintaining first-tree context trees.",
    );
    for (const commandName of commandNames) {
      expect(result.stdout).toContain(commandName);
    }
    expect(result.stdout).toContain("All commands:");
    for (const commandPath of rootHelpCommandPaths) {
      expect(result.stdout).toContain(commandPath);
    }
  });

  it("runs the init placeholder successfully", async () => {
    const result = await runCli(["init"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("first-tree init is not implemented yet.");
  });

  for (const commandGroup of commandGroups) {
    it(`prints ${commandGroup.name} help with registered subcommands`, async () => {
      const result = await runCli([commandGroup.name, "--help"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: first-tree ${commandGroup.name}`);
      expect(result.stdout).not.toContain("All commands:");
      for (const subcommandName of commandGroup.subcommands) {
        expect(result.stdout).toContain(subcommandName);
      }
    });

    it(`prints ${commandGroup.name} help when no subcommand is provided`, async () => {
      const result = await runCli([commandGroup.name]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: first-tree ${commandGroup.name}`);
      expect(result.stdout).not.toContain("All commands:");
      for (const subcommandName of commandGroup.subcommands) {
        expect(result.stdout).toContain(subcommandName);
      }
    });

    for (const subcommandName of commandGroup.subcommands) {
      it(`runs the ${commandGroup.name} ${subcommandName} placeholder successfully`, async () => {
        const result = await runCli([commandGroup.name, subcommandName]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout.trim()).toBe(
          `first-tree ${commandGroup.name} ${subcommandName} is not implemented yet.`,
        );
      });

      it(`prints ${commandGroup.name} ${subcommandName} help after an invalid option`, async () => {
        const result = await runCli([commandGroup.name, subcommandName, "--bad-option"]);

        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("error: unknown option '--bad-option'");
        expect(result.stderr).toContain(`Usage: first-tree ${commandGroup.name} ${subcommandName}`);
        expect(result.stderr).toContain("Options:");
      });
    }
  }

  it("suggests a third-level subcommand for an unknown typo", async () => {
    const result = await runCli(["tree", "inspec"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'inspec'");
    expect(result.stderr).toContain("(Did you mean inspect?)");
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
