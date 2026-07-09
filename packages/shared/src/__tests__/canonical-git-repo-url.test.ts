import { describe, expect, it, vi } from "vitest";
import { canonicalGitRepoUrl } from "../canonical-git-repo-url.js";

describe("canonicalGitRepoUrl", () => {
  it("canonicalizes https URLs to host/owner/repo", () => {
    expect(canonicalGitRepoUrl("https://github.com/acme/first-tree-context.git")).toBe(
      "github.com/acme/first-tree-context",
    );
    expect(canonicalGitRepoUrl("https://GitHub.com/acme/first-tree-context/")).toBe(
      "github.com/acme/first-tree-context",
    );
  });

  it("canonicalizes scp-like ssh URLs to the same identity as https", () => {
    expect(canonicalGitRepoUrl("git@github.com:acme/first-tree-context.git")).toBe(
      canonicalGitRepoUrl("https://github.com/acme/first-tree-context"),
    );
  });

  it("treats different repos as different identities", () => {
    expect(canonicalGitRepoUrl("https://github.com/acme/first-tree")).not.toBe(
      canonicalGitRepoUrl("https://github.com/acme/first-tree-context"),
    );
  });

  it("returns null for empty or unparseable values", () => {
    expect(canonicalGitRepoUrl(null)).toBeNull();
    expect(canonicalGitRepoUrl(undefined)).toBeNull();
    expect(canonicalGitRepoUrl("   ")).toBeNull();
    expect(canonicalGitRepoUrl("not a url")).toBeNull();
    expect(canonicalGitRepoUrl("https://github.com/")).toBeNull();
    expect(canonicalGitRepoUrl("github.com:.git")).toBeNull();
    expect(canonicalGitRepoUrl("git@github.com:////.git")).toBeNull();
  });

  it("defensively rejects scp-like matches with missing capture values", () => {
    const originalExec = RegExp.prototype.exec;
    const execSpy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      value: string,
    ): RegExpExecArray | null {
      if (value === "force-empty-scp-host") {
        const match: RegExpExecArray = Object.assign(["force-empty-scp-host", "", "owner/repo"], {
          index: 0,
          input: value,
        });
        return match;
      }
      return Reflect.apply(originalExec, this, [value]);
    });

    try {
      expect(canonicalGitRepoUrl("force-empty-scp-host")).toBeNull();
    } finally {
      execSpy.mockRestore();
    }
  });
});
