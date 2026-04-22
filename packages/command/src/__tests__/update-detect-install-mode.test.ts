import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectInstallMode } from "../core/update.js";

describe("detectInstallMode", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ftHub-install-mode-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns 'source' when a .git sibling is found", () => {
    const binDir = join(root, "repo", "packages", "command", "dist", "cli");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    const argv1 = join(binDir, "index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1)).toBe("source");
  });

  it("returns 'global' when parent package.json matches the published name", () => {
    const pkgDir = join(root, ".nvm/versions/node/v22/lib/node_modules/@agent-team-foundation/first-tree-hub");
    mkdirSync(join(pkgDir, "dist/cli"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@agent-team-foundation/first-tree-hub", version: "0.9.2" }),
    );
    const argv1 = join(pkgDir, "dist/cli/index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1)).toBe("global");
  });

  it("returns 'npx' when the package dir lives under an _npx cache root", () => {
    const pkgDir = join(root, ".npm/_npx/abc123/node_modules/@agent-team-foundation/first-tree-hub");
    mkdirSync(join(pkgDir, "dist/cli"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@agent-team-foundation/first-tree-hub", version: "0.9.2" }),
    );
    const argv1 = join(pkgDir, "dist/cli/index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1)).toBe("npx");
  });

  it("returns 'npx' when no matching package.json or .git is found", () => {
    const argv1 = join(root, "stray/dir/no-package.mjs");
    mkdirSync(join(root, "stray/dir"), { recursive: true });
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1)).toBe("npx");
  });
});
