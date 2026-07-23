import { describe, expect, it, vi } from "vitest";
import {
  adoptContextTreeRemote,
  type ContextTreeForgeRunner,
  createContextTreeRemote,
  resolveContextTreeForgeCoordinate,
  verifyContextTreeForgeAuth,
} from "../core/context-tree-forge/index.js";

describe("Context Tree forge adapters", () => {
  it("preserves nested GitLab namespaces and targets the exact Self-Managed host", () => {
    const coordinate = resolveContextTreeForgeCoordinate("gitlab", "git@gitlab.example:Group/Subgroup/Tree.git");
    expect(coordinate).toEqual({
      provider: "gitlab",
      repoUrl: "git@gitlab.example:Group/Subgroup/Tree.git",
      host: "gitlab.example",
      path: "group/subgroup/tree",
      webUrl: "https://gitlab.example/group/subgroup/tree",
    });

    const run = vi.fn<ContextTreeForgeRunner>();
    verifyContextTreeForgeAuth(coordinate, "/task", run);
    expect(run).toHaveBeenCalledWith("glab", ["auth", "status", "--hostname", "gitlab.example"], "/task");
  });

  it("preserves the exact HTTPS port for GitLab CLI authentication and API calls", () => {
    const coordinate = resolveContextTreeForgeCoordinate(
      "gitlab",
      "https://gitlab.example:8443/Group/Subgroup/Tree.git",
    );
    expect(coordinate.host).toBe("gitlab.example:8443");
    expect(coordinate.webUrl).toBe("https://gitlab.example:8443/group/subgroup/tree");

    const run = vi.fn<ContextTreeForgeRunner>();
    verifyContextTreeForgeAuth(coordinate, "/task", run);
    expect(run).toHaveBeenCalledWith("glab", ["auth", "status", "--hostname", "gitlab.example:8443"], "/task");
  });

  it("maps SSH and scp-like GitLab repositories to the trusted non-default Web/API port", () => {
    for (const repo of [
      "git@gitlab.example:Group/Subgroup/Tree.git",
      "ssh://git@gitlab.example:2222/Group/Subgroup/Tree.git",
    ]) {
      const coordinate = resolveContextTreeForgeCoordinate("gitlab", repo, "https://gitlab.example:8443");
      expect(coordinate.host).toBe("gitlab.example:8443");
      expect(coordinate.webUrl).toBe("https://gitlab.example:8443/group/subgroup/tree");
    }
    expect(() =>
      resolveContextTreeForgeCoordinate(
        "gitlab",
        "git@gitlab.example:Group/Subgroup/Tree.git",
        "https://gitlab.example:9443",
      ),
    ).not.toThrow();
    expect(() =>
      resolveContextTreeForgeCoordinate(
        "gitlab",
        "git@other.example:Group/Subgroup/Tree.git",
        "https://gitlab.example:8443",
      ),
    ).toThrow("must match the Team's current GitLab connection");
  });

  it("creates GitLab without any GitHub App, approval, or ruleset command", () => {
    const coordinate = resolveContextTreeForgeCoordinate("gitlab", "https://gitlab.example/group/sub/tree.git");
    const run = vi.fn<ContextTreeForgeRunner>((command, args) => {
      if (command === "glab" && args[0] === "repo" && args[1] === "view") {
        throw new Error("not found");
      }
      return "";
    });

    createContextTreeRemote({ coordinate, branch: "main", public: false, treeRoot: "/task/tree" }, run);

    expect(run).toHaveBeenCalledWith(
      "glab",
      ["repo", "create", "group/sub/tree", "--private", "--defaultBranch", "main"],
      "/task/tree",
      { GITLAB_HOST: "gitlab.example" },
    );
    expect(run).toHaveBeenCalledWith(
      "git",
      ["remote", "add", "origin", "https://gitlab.example/group/sub/tree.git"],
      "/task/tree",
    );
    expect(run).toHaveBeenCalledWith("git", ["push", "--set-upstream", "origin", "main"], "/task/tree");
    const flattened = run.mock.calls.map(([command, args]) => `${command} ${args.join(" ")}`).join("\n");
    expect(flattened).not.toMatch(/\bgh\b|approve|ruleset|CODEOWNERS|merge queue/iu);
  });

  it("adopts only the requested readable branch and never pushes", () => {
    const coordinate = resolveContextTreeForgeCoordinate("github", "https://github.com/acme/context-tree");
    const run = vi.fn<ContextTreeForgeRunner>((command, args) => {
      if (command === "git" && args[0] === "ls-remote") {
        return "a".repeat(40);
      }
      return "";
    });

    adoptContextTreeRemote({ coordinate, branch: "release", treeRoot: "/task/tree" }, run);

    expect(run).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--exit-code", "--heads", coordinate.repoUrl, "refs/heads/release"],
      "/task/tree",
    );
    expect(run).toHaveBeenCalledWith(
      "git",
      ["clone", "--branch", "release", "--single-branch", "--", coordinate.repoUrl, "/task/tree"],
      process.cwd(),
    );
    expect(run.mock.calls.some(([command, args]) => command === "git" && args[0] === "push")).toBe(false);
  });

  it("rejects provider/repository mismatches before any command", () => {
    expect(() => resolveContextTreeForgeCoordinate("gitlab", "https://github.com/acme/context-tree")).toThrow(
      /cannot be used with a github\.com repository/u,
    );
    expect(() => resolveContextTreeForgeCoordinate("github", "https://gitlab.example/acme/context-tree")).toThrow(
      /must use github\.com/u,
    );
  });

  it.each([
    "http://gitlab.example/acme/context-tree",
    "ftp://gitlab.example/acme/context-tree",
    "file:///tmp/context-tree",
    "https://user:secret@gitlab.example/acme/context-tree",
    "https://gitlab.example/acme/context-tree?token=secret",
    "https://gitlab.example/acme/context-tree#fragment",
  ])("rejects unsafe repository transport before any forge command: %s", (repo) => {
    expect(() => resolveContextTreeForgeCoordinate("gitlab", repo)).toThrow("credential-free HTTPS, ssh://");
  });
});
