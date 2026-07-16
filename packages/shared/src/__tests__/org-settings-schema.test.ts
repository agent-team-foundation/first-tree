import { describe, expect, it } from "vitest";
import { initializeContextTreeResponseSchema } from "../schemas/context-tree.js";
import {
  classifyContextTreeSetting,
  contextTreeActiveBindingSchema,
  contextTreeBranchSchema,
  contextTreeRepoSchema,
  isOrgSettingNamespace,
  orgContextTreeFeaturesInputSchema,
  orgContextTreeFeaturesOutputSchema,
  orgContextTreeFeaturesStorageSchema,
  orgContextTreeFinalizeInputSchema,
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
      "https://github.com/org/tree\ud800.git",
      "git@github.com:org/tree\udfff.git",
    ]) {
      expect(contextTreeRepoSchema.safeParse(repo).success, repo).toBe(false);
      expect(orgContextTreeInputSchema.safeParse({ repo }).success, repo).toBe(false);
    }
  });

  it("accepts Context Tree branches allowed by git check-ref-format --branch", () => {
    for (const branch of [
      "main",
      "release/2026-07",
      "feature.context-tree",
      "@",
      "foo/-bar",
      "foo=bar",
      "foo!bar",
      "café/修复",
      "foo.LOCK",
    ]) {
      expect(contextTreeBranchSchema.parse(branch)).toBe(branch);
      expect(orgContextTreeInputSchema.parse({ branch }).branch).toBe(branch);
    }
  });

  it("rejects Context Tree branches forbidden by git check-ref-format --branch", () => {
    for (const branch of [
      "",
      "HEAD",
      "--bad",
      " main",
      "main ",
      "main\nnext",
      "main\rnext",
      "main\u0001",
      "feature..next",
      ".hidden",
      "feature/.hidden",
      "release.lock",
      "feature/release.lock",
      "topic~1",
      "topic^1",
      "topic:next",
      "topic?next",
      "topic*next",
      "topic[next",
      "topic\\next",
      "topic@{next",
      "/topic",
      "topic/",
      "topic//next",
      "topic.",
      `topic${String.fromCharCode(0x7f)}next`,
    ]) {
      expect(contextTreeBranchSchema.safeParse(branch).success, JSON.stringify(branch)).toBe(false);
      expect(orgContextTreeInputSchema.safeParse({ branch }).success, JSON.stringify(branch)).toBe(false);
    }
  });

  it("rejects additional control and line-separator characters", () => {
    // Git accepts these Unicode characters, but they can split terminal or
    // structured output and are outside the Context Tree single-line contract.
    for (const branch of ["main\u0085", "main\u2028next", "main\u2029next"]) {
      expect(contextTreeBranchSchema.safeParse(branch).success, JSON.stringify(branch)).toBe(false);
      expect(orgContextTreeInputSchema.safeParse({ branch }).success, JSON.stringify(branch)).toBe(false);
    }
  });

  it("rejects unpaired UTF-16 surrogates while preserving paired code points", () => {
    for (const surrogate of ["\ud800", "\udfff"]) {
      const branch = `feature/${surrogate}`;
      expect(contextTreeBranchSchema.safeParse(branch).success, JSON.stringify(branch)).toBe(false);
      expect(orgContextTreeInputSchema.safeParse({ branch }).success, JSON.stringify(branch)).toBe(false);
    }

    const pairedBranch = "feature/\ud83d\ude80";
    expect(contextTreeBranchSchema.parse(pairedBranch)).toBe(pairedBranch);
    const pairedRepo = "https://github.com/org/tree-\ud83d\ude80.git";
    expect(contextTreeRepoSchema.parse(pairedRepo)).toBe(pairedRepo);
  });

  it("rejects unknown Context Tree input fields", () => {
    expect(
      orgContextTreeInputSchema.safeParse({ repo: "https://github.com/org/tree.git", unexpected: true }).success,
    ).toBe(false);
  });

  it("requires the Context Tree finalization sentinel and keeps both inputs strict", () => {
    const input = {
      repo: "https://github.com/org/tree.git",
      branch: "main",
      expectedUnboundBranch: "main",
    } as const;
    expect(orgContextTreeFinalizeInputSchema.parse(input)).toEqual(input);
    expect(orgContextTreeInputSchema.safeParse(input).success).toBe(false);

    for (const value of [
      { branch: input.branch, expectedUnboundBranch: input.expectedUnboundBranch },
      { repo: input.repo, expectedUnboundBranch: input.expectedUnboundBranch },
      { repo: input.repo, branch: input.branch },
      { ...input, repo: "http://github.com/org/tree.git" },
      { ...input, branch: "bad..branch" },
      { repo: input.repo, branch: input.branch, expectedUnboundBranch: "" },
      { repo: input.repo, branch: input.branch, expectedUnboundBranch: "bad..branch" },
      { repo: input.repo, branch: input.branch, expectedUnboundBranch: null },
      { repo: input.repo, branch: input.branch, expectedUnboundBranch: 123 },
      {
        repo: { value: input.repo, expectedUnboundBranch: input.expectedUnboundBranch },
        branch: input.branch,
      },
      { ...input, unexpected: true },
    ]) {
      expect(orgContextTreeFinalizeInputSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
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

  it("normalizes and validates active Context Tree bindings", () => {
    const repo = "git@github.com:org/tree.git";

    expect(contextTreeActiveBindingSchema.parse({ repo })).toEqual({ repo, branch: "main" });
    expect(contextTreeActiveBindingSchema.parse({ repo, branch: null })).toEqual({ repo, branch: "main" });
    expect(contextTreeActiveBindingSchema.parse({ repo, branch: "release/2026-07" })).toEqual({
      repo,
      branch: "release/2026-07",
    });

    for (const binding of [
      {},
      { repo: "http://legacy.example.com/context-tree.git", branch: "main" },
      { repo, branch: "feature..next" },
    ]) {
      expect(contextTreeActiveBindingSchema.safeParse(binding).success, JSON.stringify(binding)).toBe(false);
    }
  });

  it("classifies raw Context Tree settings without exposing invalid values", () => {
    const repo = "https://github.com/org/tree.git";
    expect(classifyContextTreeSetting({})).toEqual({ kind: "unbound", branch: "main" });
    expect(classifyContextTreeSetting({ branch: "trunk" })).toEqual({ kind: "unbound", branch: "trunk" });
    expect(classifyContextTreeSetting({ repo })).toEqual({
      kind: "bound",
      binding: { repo, branch: "main" },
    });
    expect(classifyContextTreeSetting({ repo, branch: "release/2026-07" })).toEqual({
      kind: "bound",
      binding: { repo, branch: "release/2026-07" },
    });

    for (const value of [
      undefined,
      null,
      [],
      { repo: null, branch: "main" },
      { repo: "", branch: "main" },
      { repo: 123, branch: "main" },
      { branch: null },
      { branch: "--bad" },
      { repo: "http://legacy.example/tree.git", branch: "main" },
      { repo, branch: null },
      { repo, branch: "bad..branch" },
    ]) {
      expect(classifyContextTreeSetting(value), JSON.stringify(value)).toEqual({ kind: "invalid" });
    }
  });

  it("accepts only credential-free GitHub repository HTML URLs in initialize responses", () => {
    const response = {
      repo: "https://github.com/org/tree.git",
      htmlUrl: "https://github.com/org/tree",
      branch: "main",
      nodePath: "NODE.md",
    } as const;
    expect(initializeContextTreeResponseSchema.parse(response)).toEqual(response);
    expect(
      initializeContextTreeResponseSchema.safeParse({
        ...response,
        repo: "https://github.com/other/tree.git",
      }).success,
    ).toBe(false);

    for (const htmlUrl of [
      "http://github.com/org/tree",
      "ftp://github.com/org/tree",
      "javascript:alert(1)",
      "https://user:secret@github.com/org/tree",
      "https://example.com/org/tree",
      "https://github.com/org",
      "https://github.com/org/tree?token=secret",
      "https://github.com/org/tree#readme",
      " https://github.com/org/tree",
      "https://github.com:444/org/tree",
      "https://@github.com/org/tree",
      "https://github.com//org/tree",
      "https://github.com/org/tree/",
      "https://github.com/org/tree name",
      "https://github.com/org/tree\u2028name",
      "https://github.com/org%2Fother/tree",
      "https://github.com/org/tree%5Cother",
      "https://github.com/org/tree\u0085forged",
      "https://github.com/org\\tree",
    ]) {
      const parsed = initializeContextTreeResponseSchema.safeParse({ ...response, htmlUrl });
      expect(parsed.success, htmlUrl).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) => issue.path[0] === "htmlUrl"),
          htmlUrl,
        ).toBe(true);
      }
    }

    for (const coordinates of [
      { htmlUrl: "https://example.com/org/tree", repo: "https://example.com/org/tree.git" },
      { htmlUrl: "https://github.com/org/tree/extra", repo: "https://github.com/org/tree/extra.git" },
    ]) {
      const parsed = initializeContextTreeResponseSchema.safeParse({ ...response, ...coordinates });
      expect(parsed.success, JSON.stringify(coordinates)).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) => issue.path[0] === "htmlUrl"),
          JSON.stringify(coordinates),
        ).toBe(true);
      }
    }

    for (const coordinates of [
      { htmlUrl: "https://github.com/org/.", repo: "https://github.com/org/..git" },
      { htmlUrl: "https://github.com/org/..", repo: "https://github.com/org/...git" },
    ]) {
      expect(coordinates.repo).toBe(`${coordinates.htmlUrl}.git`);
      expect(contextTreeRepoSchema.safeParse(coordinates.repo).success).toBe(true);
      expect(
        initializeContextTreeResponseSchema.safeParse({ ...response, ...coordinates }).success,
        JSON.stringify(coordinates),
      ).toBe(false);
    }
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
      contextReviewer: {
        enabled: false,
        agentUuid: null,
        workflow: "legacy_app",
        governance: "human",
        mergeMethod: "squash",
      },
    });
    expect(
      orgContextTreeFeaturesStorageSchema.parse({
        contextReviewer: { enabled: true, agentUuid: "agent-1" },
      }),
    ).toEqual({
      contextReviewer: {
        enabled: true,
        agentUuid: "agent-1",
        workflow: "legacy_app",
        governance: "human",
        mergeMethod: "squash",
      },
    });
    expect(() =>
      orgContextTreeFeaturesStorageSchema.parse({
        contextReviewer: { enabled: true, agentUuid: null },
      }),
    ).toThrow("agentUuid is required");
    expect(orgContextTreeFeaturesOutputSchema.parse({})).toEqual({
      contextReviewer: {
        enabled: false,
        agentUuid: null,
        workflow: "legacy_app",
        governance: "human",
        mergeMethod: "squash",
        reviewerAgent: null,
      },
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
        workflow: "legacy_app",
        governance: "human",
        mergeMethod: "squash",
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
    expect(
      orgContextTreeFeaturesInputSchema.parse({
        contextReviewer: {
          enabled: true,
          agentUuid: "agent-1",
          workflow: "agent_review",
          governance: "autonomous",
          mergeMethod: "rebase",
        },
      }),
    ).toEqual({
      contextReviewer: {
        enabled: true,
        agentUuid: "agent-1",
        workflow: "agent_review",
        governance: "autonomous",
        mergeMethod: "rebase",
      },
    });
    expect(() =>
      orgContextTreeFeaturesInputSchema.parse({
        contextReviewer: {
          enabled: true,
          agentUuid: "agent-1",
          workflow: "legacy_app",
          governance: "autonomous",
        },
      }),
    ).toThrow("legacy_app Context Reviewer only supports human governance");
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
