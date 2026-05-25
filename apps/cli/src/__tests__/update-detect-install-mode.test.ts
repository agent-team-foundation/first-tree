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

  it("returns 'source' immediately when packageName is null (dev channel — not published)", () => {
    // dev binaries are not published to npm; there's no `node_modules/<pkg>`
    // tree to detect a "global" install against. detectInstallMode must
    // short-circuit so the update path declines self-update cleanly.
    const argv1 = join(root, "anywhere", "index.mjs");
    mkdirSync(join(root, "anywhere"), { recursive: true });
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1, null)).toBe("source");
  });

  it("returns 'source' when a .git sibling is found", () => {
    const binDir = join(root, "repo", "packages", "command", "dist", "cli");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    const argv1 = join(binDir, "index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1, "first-tree")).toBe("source");
  });

  it("returns 'global' when parent package.json matches the published name", () => {
    const pkgDir = join(root, ".nvm/versions/node/v22/lib/node_modules/first-tree");
    mkdirSync(join(pkgDir, "dist/cli"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "first-tree", version: "0.9.2" }));
    const argv1 = join(pkgDir, "dist/cli/index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1, "first-tree")).toBe("global");
  });

  it("returns 'npx' when the package dir lives under an _npx cache root", () => {
    const pkgDir = join(root, ".npm/_npx/abc123/node_modules/first-tree");
    mkdirSync(join(pkgDir, "dist/cli"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "first-tree", version: "0.9.2" }));
    const argv1 = join(pkgDir, "dist/cli/index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1, "first-tree")).toBe("npx");
  });

  it("returns 'npx' when no matching package.json or .git is found", () => {
    const argv1 = join(root, "stray/dir/no-package.mjs");
    mkdirSync(join(root, "stray/dir"), { recursive: true });
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1, "first-tree")).toBe("npx");
  });

  it("classifies a global install as 'global' when invoked through a symlinked bin/", () => {
    // Regression: standard `npm i -g` lays the binary out as
    // `<prefix>/bin/<name> -> ../lib/node_modules/<pkg>/dist/cli/index.mjs`.
    // process.argv[1] keeps the symlink path, so without realpath the walk
    // starts in `<prefix>/bin/` and never reaches the package.json — the
    // command falls through to "npx" and `update` refuses to run.
    const prefix = join(root, "usr", "local");
    const pkgDir = join(prefix, "lib", "node_modules", "@agent-team-foundation", "first-tree");
    mkdirSync(join(pkgDir, "dist", "cli"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "first-tree", version: "0.10.12" }));
    const target = join(pkgDir, "dist", "cli", "index.mjs");
    writeFileSync(target, "// stub");

    const binDir = join(prefix, "bin");
    mkdirSync(binDir, { recursive: true });
    const binLink = join(binDir, "first-tree");
    symlinkSync(target, binLink);

    expect(detectInstallMode(binLink, "first-tree")).toBe("global");
  });

  it("classifies a global install as 'global' even when an ancestor of the npm prefix has a .git dir", () => {
    // Regression: operators occasionally `git init` their npm prefix (e.g.
    // a Homebrew prefix at `/opt/homebrew/` tracked as a personal repo).
    // The ancestor `.git` would short-circuit Pass 1 and mis-classify the
    // install as "source", causing self-update to silently skip forever
    // with "Running from source checkout — self-update skipped".
    const prefix = join(root, "opt", "homebrew");
    mkdirSync(join(prefix, ".git"), { recursive: true });
    const pkgDir = join(prefix, "lib", "node_modules", "@agent-team-foundation", "first-tree");
    mkdirSync(join(pkgDir, "dist", "cli"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "first-tree", version: "0.14.2" }));
    const argv1 = join(pkgDir, "dist", "cli", "index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1, "first-tree")).toBe("global");
  });

  it("classifies a global install as 'global' when $HOME is managed by dotfiles git (yadm / chezmoi)", () => {
    // Regression: users on yadm / chezmoi / homeshick track the whole
    // `$HOME` in git, and frequently `npm config set prefix ~/.local`.
    // Before the fix, the `~/.git` ancestor flipped detection to "source"
    // and silently broke auto-update for that entire user segment.
    const home = join(root, "home", "alice");
    mkdirSync(join(home, ".git"), { recursive: true });
    const pkgDir = join(home, ".local", "lib", "node_modules", "@agent-team-foundation", "first-tree");
    mkdirSync(join(pkgDir, "dist", "cli"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "first-tree", version: "0.14.2" }));
    const argv1 = join(pkgDir, "dist", "cli", "index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1, "first-tree")).toBe("global");
  });

  it("still classifies an npx cache as 'npx' even when an ancestor has a .git dir", () => {
    // The node_modules short-circuit must not promote npx caches to
    // "global" — the `_npx` segment check in Pass 2 is what differentiates
    // them, and it has to keep running.
    const home = join(root, "home", "alice");
    mkdirSync(join(home, ".git"), { recursive: true });
    const pkgDir = join(home, ".npm", "_npx", "abc123", "node_modules", "@agent-team-foundation", "first-tree");
    mkdirSync(join(pkgDir, "dist", "cli"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "first-tree", version: "0.14.2" }));
    const argv1 = join(pkgDir, "dist", "cli", "index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1, "first-tree")).toBe("npx");
  });

  it("treats a dist build inside a checkout as 'source' even when an inner package.json matches our name", () => {
    // Simulates `scripts/dev-cli.sh` running `node apps/cli/dist/index.mjs`
    // from inside the monorepo: the inner package.json (name matches) lives
    // at `apps/cli/`, but `.git` lives at the repo root. Without
    // strict source-precedence the scan would hit the inner package.json
    // first and misclassify the dev build as "global", causing `update` to
    // overwrite the operator's prod install via `npm i -g`.
    const repo = join(root, "checkout");
    const pkgDir = join(repo, "packages", "command");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "first-tree", version: "0.10.11" }));
    const argv1 = join(pkgDir, "dist", "index.mjs");
    writeFileSync(argv1, "// stub");
    expect(detectInstallMode(argv1, "first-tree")).toBe("source");
  });
});
