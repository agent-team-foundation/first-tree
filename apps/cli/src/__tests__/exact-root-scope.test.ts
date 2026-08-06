import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_TREE_SCOPE_MAX_BYTES } from "@first-tree/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextRootScopeError,
  type ContextRootScopeErrorKind,
  fetchExactScope,
} from "../core/context-integration/exact-root-scope.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("exact root SCOPE reader", () => {
  it("returns the exact commit and parsed root SCOPE", () => {
    const repository = createRepository();
    writeFileSync(join(repository, "SCOPE.md"), "---\nschemaVersion: 1\n---\n\nCustomer operations.\n");
    commitAll(repository, "valid scope");

    expect(fetchScope(repository)).toMatchObject({
      commit: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
      scope: { schemaVersion: 1, relatedRepositories: [], body: "Customer operations." },
    });
  });

  it("classifies a missing root SCOPE as missing", () => {
    const repository = createRepository();
    writeFileSync(join(repository, "README.md"), "No root scope.\n");
    commitAll(repository, "missing scope");

    expectFailure(() => fetchScope(repository), "missing");
  });

  it("classifies a non-regular root SCOPE as missing", () => {
    const repository = createRepository();
    writeFileSync(join(repository, "scope-target.md"), "---\nschemaVersion: 1\n---\n\nLinked scope.\n");
    symlinkSync("scope-target.md", join(repository, "SCOPE.md"));
    commitAll(repository, "linked scope");

    expectFailure(() => fetchScope(repository), "missing");
  });

  it("classifies oversized content before reading the blob", () => {
    const repository = createRepository();
    writeFileSync(
      join(repository, "SCOPE.md"),
      `---\nschemaVersion: 1\n---\n\n${"x".repeat(CONTEXT_TREE_SCOPE_MAX_BYTES)}`,
    );
    commitAll(repository, "oversized scope");

    const error = expectFailure(() => fetchScope(repository), "invalid");
    expect(error.message).toContain(`${CONTEXT_TREE_SCOPE_MAX_BYTES}-byte limit`);
  });

  it("classifies non-UTF-8 content as invalid", () => {
    const repository = createRepository();
    writeFileSync(
      join(repository, "SCOPE.md"),
      Buffer.concat([Buffer.from("---\nschemaVersion: 1\n---\n", "utf8"), Buffer.from([0xc3, 0x28])]),
    );
    commitAll(repository, "non-utf8 scope");

    expectFailure(() => fetchScope(repository), "invalid");
  });

  it("classifies schema-invalid content as invalid", () => {
    const repository = createRepository();
    writeFileSync(join(repository, "SCOPE.md"), "No frontmatter.\n");
    commitAll(repository, "invalid scope");

    expectFailure(() => fetchScope(repository), "invalid");
  });

  it("classifies repository and branch failures as fetch failures", () => {
    const repository = createRepository();

    expectFailure(
      () =>
        fetchExactScope({
          provider: "github",
          repo: repository,
          branch: "missing-branch",
        }),
      "fetch",
    );
  });
});

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "exact-root-scope-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  return root;
}

function commitAll(repository: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-m", message], { cwd: repository, stdio: "ignore" });
}

function fetchScope(repository: string): ReturnType<typeof fetchExactScope> {
  return fetchExactScope({ provider: "github", repo: repository, branch: "main" });
}

function expectFailure(action: () => unknown, kind: ContextRootScopeErrorKind): ContextRootScopeError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ContextRootScopeError);
    if (error instanceof ContextRootScopeError) {
      expect(error.kind).toBe(kind);
      return error;
    }
    throw error;
  }
  throw new Error(`Expected ContextRootScopeError with kind ${kind}.`);
}
