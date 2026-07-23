import { describe, expect, it, vi } from "vitest";
import {
  canonicalGitRepoIdentity,
  canonicalGitRepoUrl,
  resolveContextTreeProvider,
  resolveGitLabRepositoryWebIdentity,
  sameContextTreeRepository,
} from "../canonical-git-repo-url.js";

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

  it("preserves nested GitLab namespaces and normalizes identity casing", () => {
    expect(canonicalGitRepoUrl("ssh://git@GitLab.Example.COM/Group/SubGroup/Context-Tree.GIT/")).toBe(
      "gitlab.example.com/group/subgroup/context-tree",
    );
    expect(canonicalGitRepoIdentity("git@gitlab.example.com:Group/SubGroup/Context-Tree.git")).toEqual({
      canonical: "gitlab.example.com/group/subgroup/context-tree",
      host: "gitlab.example.com",
      path: "group/subgroup/context-tree",
    });
  });

  it("resolves providers only from a declaration or an authoritative host", () => {
    expect(resolveContextTreeProvider({ repo: "https://github.com/Acme/Tree.git" })).toMatchObject({
      provider: "github",
      source: "github_host",
      declaredProviderMatches: true,
    });
    expect(
      resolveContextTreeProvider({
        repo: "git@gitlab.internal:Group/Tree.git",
        gitlabInstanceOrigin: "https://GITLAB.internal",
      }),
    ).toMatchObject({
      provider: "gitlab",
      source: "gitlab_connection",
      declaredProviderMatches: true,
      gitlabConnectionMatches: true,
    });
    expect(resolveContextTreeProvider({ repo: "git@unknown.internal:Group/Tree.git" })).toMatchObject({
      provider: null,
      source: "unknown",
      gitlabConnectionMatches: false,
    });
    expect(resolveContextTreeProvider({ repo: "https://github.com:8443/Acme/Tree.git" })).toMatchObject({
      provider: null,
      source: "unknown",
    });
  });

  it("reports declared-provider and GitLab-connection mismatches without guessing", () => {
    expect(
      resolveContextTreeProvider({
        repo: "https://gitlab.internal/group/tree",
        declaredProvider: "github",
        gitlabInstanceOrigin: "https://gitlab.internal",
      }),
    ).toMatchObject({
      provider: "github",
      source: "declared",
      declaredProviderMatches: false,
      gitlabConnectionMatches: true,
    });
    expect(
      resolveContextTreeProvider({
        repo: "git@gitlab.internal:group/tree.git",
        declaredProvider: "gitlab",
        gitlabInstanceOrigin: "https://other.internal",
      }),
    ).toMatchObject({
      provider: "gitlab",
      source: "declared",
      declaredProviderMatches: true,
      gitlabConnectionMatches: false,
    });
  });

  it("resolves GitLab HTTPS origin and nested project path with exact web port", () => {
    expect(
      resolveGitLabRepositoryWebIdentity(
        "https://GitLab.Internal:8443/Group/Sub/Tree.git",
        "https://gitlab.internal:8443",
      ),
    ).toEqual({
      origin: "https://gitlab.internal:8443",
      path: "group/sub/tree",
      cloneUrl: "https://gitlab.internal:8443/group/sub/tree.git",
      originMatchesConnection: true,
    });
    expect(
      resolveGitLabRepositoryWebIdentity("https://gitlab.internal:9443/group/tree.git", "https://gitlab.internal:8443")
        ?.originMatchesConnection,
    ).toBe(false);
    expect(
      resolveContextTreeProvider({
        repo: "https://gitlab.internal:9443/group/tree.git",
        gitlabInstanceOrigin: "https://gitlab.internal:8443",
      }),
    ).toMatchObject({
      provider: null,
      source: "unknown",
      gitlabConnectionMatches: false,
    });
  });

  it("maps SSH transport host to the connection web origin without reusing the SSH port", () => {
    expect(
      resolveGitLabRepositoryWebIdentity(
        "ssh://git@gitlab.internal:2222/Group/Sub/Tree.git",
        "https://gitlab.internal:8443",
      ),
    ).toMatchObject({
      origin: "https://gitlab.internal:8443",
      cloneUrl: "https://gitlab.internal:8443/group/sub/tree.git",
      originMatchesConnection: true,
    });
  });

  it("compares executable repository authority with exact forge origin semantics", () => {
    expect(
      sameContextTreeRepository({
        provider: "gitlab",
        left: "https://gitlab.internal:8443/group/tree.git",
        right: "https://gitlab.internal:9443/group/tree",
      }),
    ).toBe(false);
    expect(
      sameContextTreeRepository({
        provider: "gitlab",
        left: "ssh://git@gitlab.internal:2222/group/tree.git",
        right: "https://gitlab.internal:8443/group/tree",
        gitlabInstanceOrigin: "https://gitlab.internal:8443",
      }),
    ).toBe(true);
    expect(
      sameContextTreeRepository({
        provider: "gitlab",
        left: "ssh://git@gitlab.internal:2222/group/tree.git",
        right: "https://gitlab.internal:9443/group/tree",
        gitlabInstanceOrigin: "https://gitlab.internal:8443",
      }),
    ).toBe(false);
    expect(
      sameContextTreeRepository({
        provider: "github",
        left: "git@github.com:acme/tree.git",
        right: "https://github.com/acme/tree",
      }),
    ).toBe(true);
    expect(
      sameContextTreeRepository({
        provider: "github",
        left: "https://github.com:8443/acme/tree",
        right: "https://github.com/acme/tree",
      }),
    ).toBe(false);
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
        const match = /^([^:]*):(.*)$/.exec(":owner/repo");
        if (!match) throw new Error("test fixture failed to build scp-like match");
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
