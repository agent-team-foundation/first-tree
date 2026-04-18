import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInjectContext } from "../../src/products/tree/engine/commands/inject-context.js";
import {
  writeSourceState,
  writeTreeBinding,
  writeTreeState,
} from "../../src/products/tree/engine/runtime/binding-state.js";

describe("runInjectContext", () => {
  let tmpDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logged: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "inject-context-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    logged = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logged.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits hook payload when NODE.md exists", () => {
    writeFileSync(join(tmpDir, "NODE.md"), "# Root\nbody\n");
    const code = runInjectContext([]);
    expect(code).toBe(0);
    expect(logged).toHaveLength(1);
    const payload = JSON.parse(logged[0]);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toBe("# Root\nbody\n");
  });

  it("is silent when NODE.md is absent", () => {
    const code = runInjectContext([]);
    expect(code).toBe(0);
    expect(logged).toHaveLength(0);
  });

  it("escapes special characters via JSON.stringify", () => {
    writeFileSync(join(tmpDir, "NODE.md"), 'has "quotes" and\nnewlines\tand\\backslash');
    const code = runInjectContext([]);
    expect(code).toBe(0);
    const payload = JSON.parse(logged[0]);
    expect(payload.hookSpecificOutput.additionalContext).toBe(
      'has "quotes" and\nnewlines\tand\\backslash',
    );
  });

  it("resolves tree-first context from a bound source repo", () => {
    const sourceRoot = join(tmpDir, "product-repo");
    const treeRoot = join(tmpDir, "org-context");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(treeRoot, { recursive: true });
    writeFileSync(
      join(treeRoot, "NODE.md"),
      [
        "---",
        "title: Org Context",
        "owners: [alice]",
        "---",
        "",
        "# Org Context",
        "",
        "Shared context for the organization.",
        "",
      ].join("\n"),
    );
    writeTreeState(treeRoot, {
      treeId: "org-context",
      treeMode: "shared",
      treeRepoName: "org-context",
    });
    writeSourceState(sourceRoot, {
      bindingMode: "shared-source",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "product-repo-1234abcd",
      sourceName: "product-repo",
      tree: {
        entrypoint: "/workspaces/product-repo",
        localPath: relative(sourceRoot, treeRoot),
        remoteUrl: "https://github.com/acme/org-context.git",
        treeId: "org-context",
        treeMode: "shared",
        treeRepoName: "org-context",
      },
    });
    writeTreeBinding(treeRoot, "product-repo-1234abcd", {
      bindingMode: "shared-source",
      entrypoint: "/workspaces/product-repo",
      remoteUrl: "git@github.com:acme/product-repo.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "product-repo-1234abcd",
      sourceName: "product-repo",
      sourceRootPath: relative(treeRoot, sourceRoot),
      treeMode: "shared",
      treeRepoName: "org-context",
    });
    process.chdir(sourceRoot);

    const code = runInjectContext([]);

    expect(code).toBe(0);
    const payload = JSON.parse(logged[0]);
    expect(payload.hookSpecificOutput.additionalContext).toContain("# Org Context");
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "## Tree-First Cross-Repo Working Context",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "`/workspaces/product-repo`",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "[acme/product-repo](https://github.com/acme/product-repo)",
    );
  });

  it("prints help with --help", () => {
    const code = runInjectContext(["--help"]);
    expect(code).toBe(0);
    expect(logged.join("\n")).toContain("first-tree tree inject-context");
  });
});
