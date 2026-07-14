import { describe, expect, it } from "vitest";
import {
  contextTreeBranchSchema,
  contextTreeRepoSchema,
  isOrgSettingNamespace,
  orgContextTreeFeaturesInputSchema,
  orgContextTreeFeaturesOutputSchema,
  orgContextTreeFeaturesStorageSchema,
  orgContextTreeInputSchema,
  orgContextTreeStorageSchema,
  orgSettingNamespaceSchema,
  orgSourceReposInputSchema,
} from "../schemas/org-settings.js";

describe("org settings schemas", () => {
  it("accepts supported repository URL forms", () => {
    for (const repo of [
      "https://github.com/org/tree.git",
      "ssh://git@github.com/org/tree.git",
      "git@github.com:org/tree.git",
      "git@github_com:org/tree.git",
      "git:org/tree.git",
      "ssh:org/tree.git",
    ]) {
      expect(contextTreeRepoSchema.parse(repo)).toBe(repo);
      expect(orgContextTreeInputSchema.parse({ repo }).repo).toBe(repo);
    }
  });

  it("rejects unsupported or malformed repository URLs", () => {
    expect(() => contextTreeRepoSchema.parse("not a url")).toThrow(
      "Repo URL must be HTTPS, SSH (ssh://...), or scp-like (git@host:path).",
    );
    expect(() => contextTreeRepoSchema.parse("http://github.com/org/tree.git")).toThrow(
      "Repo URL must use HTTPS or SSH.",
    );
    expect(() => contextTreeRepoSchema.parse("git://github.com/org/tree.git")).toThrow(
      "Repo URL must use HTTPS or SSH.",
    );
    expect(() => contextTreeRepoSchema.parse("https://user@github.com/org/tree.git")).toThrow(
      "Repo URL must not include credentials.",
    );
    expect(() => contextTreeRepoSchema.parse("ssh://git:secret@github.com/org/tree.git")).toThrow(
      "Repo URL must not include credentials.",
    );
    expect(() => contextTreeRepoSchema.parse("github.com:1234")).toThrow("Repo URL must use HTTPS or SSH.");

    for (const repo of [
      "https://github.com",
      "ssh://git@github.com",
      "git@github.com:",
      " https://github.com/org/tree.git",
      "https://github.com/org/tree.git ",
      "https://github.com/org/tree.git\n",
      "git@github.com:org/\u0000tree.git",
      "https:/github.com/org/tree.git",
      "https:github.com/org/tree.git",
      "https:///github.com/org/tree.git",
      "ssh:/git@github.com/org/tree.git",
      "https://github.com\\org/tree.git",
      "C:\\Users\\alice\\context-tree.git",
      "C:context-tree.git",
      "https://github.com/org/tree.git?access_token=secret",
      "ssh://git@github.com/org/tree.git#password=secret",
      "https://github.com/org/tree.git\u2028forged",
    ]) {
      expect(contextTreeRepoSchema.safeParse(repo).success, repo).toBe(false);
      expect(orgContextTreeInputSchema.safeParse({ repo }).success, repo).toBe(false);
    }
  });

  it("requires a non-empty, single-line Context Tree branch without surrounding whitespace", () => {
    for (const branch of ["main", "release/2026-07", "feature.context-tree"]) {
      expect(contextTreeBranchSchema.parse(branch)).toBe(branch);
      expect(orgContextTreeInputSchema.parse({ branch }).branch).toBe(branch);
    }
    for (const branch of [
      "",
      " main",
      "main ",
      "main\nnext",
      "main\rnext",
      "main\u0001",
      "main\u0085",
      "main\u2028next",
    ]) {
      expect(contextTreeBranchSchema.safeParse(branch).success, JSON.stringify(branch)).toBe(false);
      expect(orgContextTreeInputSchema.safeParse({ branch }).success, JSON.stringify(branch)).toBe(false);
    }
  });

  it("rejects unknown Context Tree input fields", () => {
    expect(
      orgContextTreeInputSchema.safeParse({ repo: "https://github.com/org/tree.git", unexpected: true }).success,
    ).toBe(false);
  });

  it("keeps the Context Tree storage schema compatible with historical loose values", () => {
    expect(
      orgContextTreeStorageSchema.parse({
        repo: "http://legacy.example.com/context-tree.git",
        branch: " legacy\nbranch ",
      }),
    ).toEqual({
      repo: "http://legacy.example.com/context-tree.git",
      branch: " legacy\nbranch ",
    });
    expect(orgContextTreeStorageSchema.parse({})).toEqual({ branch: "main" });
  });

  it("validates source repo list entries with the same URL rules", () => {
    expect(
      orgSourceReposInputSchema.parse({
        repos: [{ url: "git@github.com:org/repo.git", defaultBranch: "main" }],
      }),
    ).toEqual({
      repos: [{ url: "git@github.com:org/repo.git", defaultBranch: "main" }],
    });

    expect(() =>
      orgSourceReposInputSchema.parse({
        repos: [{ url: "https://github.com/org/repo.git", defaultBranch: "" }],
      }),
    ).toThrow();
  });

  it("checks setting namespace values", () => {
    expect(orgSettingNamespaceSchema.parse("context_tree")).toBe("context_tree");
    expect(orgSettingNamespaceSchema.parse("context_tree_features")).toBe("context_tree_features");
    expect(isOrgSettingNamespace("context_tree")).toBe(true);
    expect(isOrgSettingNamespace("source_repos")).toBe(true);
    expect(isOrgSettingNamespace("context_tree_features")).toBe(true);
    expect(isOrgSettingNamespace("unknown")).toBe(false);
    expect(isOrgSettingNamespace(null)).toBe(false);
  });

  it("validates context tree feature settings", () => {
    expect(orgContextTreeFeaturesStorageSchema.parse({})).toEqual({
      contextReviewer: { enabled: false, agentUuid: null },
    });
    expect(
      orgContextTreeFeaturesStorageSchema.parse({
        contextReviewer: { enabled: true, agentUuid: "agent-1" },
      }),
    ).toEqual({
      contextReviewer: { enabled: true, agentUuid: "agent-1" },
    });
    expect(() =>
      orgContextTreeFeaturesStorageSchema.parse({
        contextReviewer: { enabled: true, agentUuid: null },
      }),
    ).toThrow("agentUuid is required");
    expect(orgContextTreeFeaturesOutputSchema.parse({})).toEqual({
      contextReviewer: { enabled: false, agentUuid: null, reviewerAgent: null },
    });
    expect(
      orgContextTreeFeaturesOutputSchema.parse({
        contextReviewer: {
          enabled: true,
          agentUuid: "agent-1",
          reviewerAgent: { uuid: "agent-1", name: "reviewer", displayName: "Context Reviewer" },
        },
      }),
    ).toEqual({
      contextReviewer: {
        enabled: true,
        agentUuid: "agent-1",
        reviewerAgent: { uuid: "agent-1", name: "reviewer", displayName: "Context Reviewer" },
      },
    });
    expect(
      orgContextTreeFeaturesInputSchema.parse({
        contextReviewer: { enabled: true, agentUuid: "agent-1" },
      }),
    ).toEqual({
      contextReviewer: { enabled: true, agentUuid: "agent-1" },
    });
    expect(() =>
      orgContextTreeFeaturesInputSchema.parse({
        contextReviewer: { enabled: true, agentUuid: null },
      }),
    ).toThrow("agentUuid is required");
    expect(() =>
      orgContextTreeFeaturesInputSchema.parse({
        contextReviewer: { enabled: true },
      }),
    ).toThrow("agentUuid is required");
  });
});
