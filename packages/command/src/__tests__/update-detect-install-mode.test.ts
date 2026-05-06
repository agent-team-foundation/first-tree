import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("classifies a global install as 'global' when invoked through a symlinked bin/", () => {
    // Regression: standard `npm i -g` lays the binary out as
    // `<prefix>/bin/<name> -> ../lib/node_modules/<pkg>/dist/cli/index.mjs`.
    // process.argv[1] keeps the symlink path, so without realpath the walk
    // starts in `<prefix>/bin/` and never reaches the package.json — the
    // command falls through to "npx" and `update` refuses to run.
    const prefix = join(root, "usr", "local");
    const pkgDir = join(prefix, "lib", "node_modules", "@agent-team-foundation", "first-tree-hub");
    mkdirSync(join(pkgDir, "dist", "cli"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@agent-team-foundation/first-tree-hub", version: "0.10.12" }),
    );
    const target = join(pkgDir, "dist", "cli", "index.mjs");
    writeFileSync(target, "// stub");

    const binDir = join(prefix, "bin");
    mkdirSync(binDir, { recursive: true });
    const binLink = join(binDir, "first-tree-hub");
    symlinkSync(target, binLink);

    expect(detectInstallMode(binLink)).toBe("global");
  });

  it("treats a dist build inside a checkout as 'source' even when an inner package.json matches our name", () => {
    // Simulates `scripts/dev-cli.sh` running `node packages/command/dist/index.mjs`
    // from inside the monorepo: the inner package.json (name matches) lives
    // at `packages/command/`, but `.git` lives at the repo root. Without
    // strict source-precedence the scan would hit the inner package.json
    // first and misclassify the dev build as "global", causing `update` to
    // overwrite the operator's prod install via `npm i -g`.
    const repo = join(root, "checkout");
    const pkgDir = join(repo, "packages", "command");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@agent-team-foundation/first-tree-hub", version: "0.10.11" }),
    );
    const argv1 = join(pkgDir, "dist", "index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1)).toBe("source");
  });
});
