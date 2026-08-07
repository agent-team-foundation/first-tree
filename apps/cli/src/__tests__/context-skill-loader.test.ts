import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveContextIntegrationRelease } from "../core/context-integration/release.js";
import { loadContextSkill } from "../core/context-integration/skill-loader.js";
import { COMMAND_VERSION } from "../core/version.js";

const roots: string[] = [];
const originalHome = process.env.FIRST_TREE_HOME;
let home = "";
let coreRoot = "";
let releaseRoot = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "first-tree-loader-home-"));
  const portableRoot = mkdtempSync(join(tmpdir(), "first-tree-loader-portable-"));
  coreRoot = join(portableRoot, "versions", COMMAND_VERSION, "app");
  releaseRoot = join(coreRoot, "context-integration");
  roots.push(home, portableRoot);
  process.env.FIRST_TREE_HOME = home;
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
  prepareCoreRoot(coreRoot);
  buildRelease(releaseRoot, coreRoot);
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

describe("Context Skill loader", () => {
  it("returns verified exact Core paths without mutating adapter observation state", () => {
    const loaded = loadContextSkill(
      {
        schemaVersion: 1,
        loaderProtocolVersion: 1,
        consumerKind: "byo",
        provider: "claude-code",
        name: "first-tree-read",
      },
      { releaseRoot, coreRoot },
    );

    expect(loaded.consumerKind).toBe("byo");
    expect(loaded.skillPath).toBe(join(coreRoot, "skills", "first-tree-read", "SKILL.md"));
    expect(loaded.policyPath).toBe(join(coreRoot, "dist", "runtime-assets", "context-tree-policy.md"));
    expect(existsSync(join(home, "data", "context-bundles"))).toBe(false);
    expect(existsSync(join(home, "state", "context", "providers", "claude-code"))).toBe(false);
  });

  it("keeps repeated loading pure across account changes", () => {
    loadContextSkill(
      {
        schemaVersion: 1,
        loaderProtocolVersion: 1,
        consumerKind: "byo",
        provider: "claude-code",
        name: "first-tree-write",
      },
      { releaseRoot, coreRoot },
    );
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_11223344\n");
    expect(existsSync(join(home, "state", "context"))).toBe(false);
  });

  it("rejects Core tampering and symbolic-link escapes instead of falling back", () => {
    writeFileSync(join(coreRoot, "skills", "first-tree-read", "SKILL.md"), "tampered\n");
    expect(() =>
      loadContextSkill(
        {
          schemaVersion: 1,
          loaderProtocolVersion: 1,
          consumerKind: "byo",
          provider: "codex",
          name: "first-tree-read",
        },
        { releaseRoot, coreRoot },
      ),
    ).toThrow("digest mismatch");

    prepareCoreRoot(coreRoot);
    const skillPath = join(coreRoot, "skills", "first-tree-read", "SKILL.md");
    const external = join(home, "external-skill.md");
    cpSync(skillPath, external);
    rmSync(skillPath);
    symlinkSync(external, skillPath);
    expect(() => resolveContextIntegrationRelease(releaseRoot, { coreRoot })).toThrow("not a regular file");
  });

  it("rejects ordinary package and source roots as mutable production loader targets", () => {
    const mutableCore = mkdtempSync(join(tmpdir(), "first-tree-loader-node_modules-"));
    const mutableRelease = join(mutableCore, "context-integration");
    roots.push(mutableCore);
    prepareCoreRoot(mutableCore);
    buildRelease(mutableRelease, mutableCore);
    expect(() =>
      loadContextSkill(
        {
          schemaVersion: 1,
          loaderProtocolVersion: 1,
          consumerKind: "byo",
          provider: "codex",
          name: "first-tree-read",
        },
        { releaseRoot: mutableRelease, coreRoot: mutableCore },
      ),
    ).toThrow("mutable CLI installation");
  });
});

function prepareCoreRoot(target: string): void {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  mkdirSync(target, { recursive: true });
  rmSync(join(target, "skills"), { recursive: true, force: true });
  cpSync(join(repoRoot, "skills"), join(target, "skills"), { recursive: true });
  const sourcePolicy = join(target, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md");
  const releasePolicy = join(target, "dist", "runtime-assets", "context-tree-policy.md");
  mkdirSync(join(sourcePolicy, ".."), { recursive: true });
  mkdirSync(join(releasePolicy, ".."), { recursive: true });
  cpSync(join(repoRoot, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md"), sourcePolicy);
  cpSync(sourcePolicy, releasePolicy);
}

function buildRelease(target: string, source: string): void {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  execFileSync(process.execPath, [
    join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
    "--out-dir",
    target,
    "--version",
    COMMAND_VERSION,
    "--channel",
    "dev",
    "--core-root",
    source,
  ]);
}
