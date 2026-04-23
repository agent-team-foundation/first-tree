import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSyncProposalBody,
  computeProposalId,
  runOpenIssuesMode,
  type ClassificationItem,
  type ClassifiedPrLike,
  type DriftReportLike,
  type RunOpenIssuesInput,
} from "#products/gardener/engine/sync.js";

const baseProposal: ClassificationItem = {
  path: "engineering/backend/auth",
  type: "TREE_MISS",
  rationale: "Auth moved to a dedicated service — no tree node yet.",
  suggested_node_title: "Auth service",
  suggested_node_body_markdown:
    "The auth service owns session issuance and token rotation.\n\nSource PR introduced the split from the monolith.",
};

describe("sync --open-issues · computeProposalId", () => {
  it("is deterministic for the same proposal", () => {
    const a = computeProposalId(baseProposal);
    const b = computeProposalId({ ...baseProposal });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs when the target path changes", () => {
    const a = computeProposalId(baseProposal);
    const b = computeProposalId({ ...baseProposal, path: "engineering/frontend/auth" });
    expect(a).not.toBe(b);
  });

  it("differs when the proposed body changes", () => {
    const a = computeProposalId(baseProposal);
    const b = computeProposalId({
      ...baseProposal,
      suggested_node_body_markdown: baseProposal.suggested_node_body_markdown + " More detail.",
    });
    expect(a).not.toBe(b);
  });

  it("ignores title changes (title is cosmetic, path + body is the identity)", () => {
    const a = computeProposalId(baseProposal);
    const b = computeProposalId({ ...baseProposal, suggested_node_title: "Different title" });
    expect(a).toBe(b);
  });
});

describe("sync --open-issues · buildSyncProposalBody", () => {
  const proposalId = "abc123def456";

  it("embeds a gardener:sync-proposal state marker with proposal_id, source_sha, node", () => {
    const body = buildSyncProposalBody({
      proposal: baseProposal,
      proposalId,
      sourceRepo: "acme/web",
      sourcePr: 42,
      sourcePrTitle: "Split auth into its own service",
      sourceSha: "deadbee",
      autoAssigned: true,
      needsOwner: false,
    });
    expect(body).toMatch(/^<!-- gardener:sync-proposal /);
    expect(body).toContain(`proposal_id=${proposalId}`);
    expect(body).toContain("source_sha=deadbee");
    expect(body).toContain(`node=${baseProposal.path}`);
  });

  it("links the source PR when numbered", () => {
    const body = buildSyncProposalBody({
      proposal: baseProposal,
      proposalId,
      sourceRepo: "acme/web",
      sourcePr: 42,
      sourcePrTitle: "Split auth",
      sourceSha: "deadbee",
      autoAssigned: true,
      needsOwner: false,
    });
    expect(body).toContain("**Source PR:** acme/web#42");
    expect(body).toContain("Split auth");
  });

  it("falls back to an unlinked-source line when sourcePr is null", () => {
    const body = buildSyncProposalBody({
      proposal: baseProposal,
      proposalId,
      sourceRepo: "acme/web",
      sourcePr: null,
      sourcePrTitle: null,
      sourceSha: null,
      autoAssigned: false,
      needsOwner: false,
    });
    expect(body).toContain("**Source:** acme/web (unlinked commits)");
    expect(body).not.toContain("**Source PR:**");
  });

  it("mentions the needs-owner fallback in the body when flagged", () => {
    const body = buildSyncProposalBody({
      proposal: baseProposal,
      proposalId,
      sourceRepo: "acme/web",
      sourcePr: 42,
      sourcePrTitle: "Split auth",
      sourceSha: "deadbee",
      autoAssigned: true,
      needsOwner: true,
    });
    expect(body.toLowerCase()).toContain("no `owners:`");
    expect(body.toLowerCase()).toContain("needs-owner");
  });

  it("uses source_sha=unknown when no sha is available", () => {
    const body = buildSyncProposalBody({
      proposal: baseProposal,
      proposalId,
      sourceRepo: "acme/web",
      sourcePr: null,
      sourcePrTitle: null,
      sourceSha: null,
      autoAssigned: false,
      needsOwner: false,
    });
    expect(body).toContain("source_sha=unknown");
  });

  it("includes the rationale and proposed node body verbatim", () => {
    const body = buildSyncProposalBody({
      proposal: baseProposal,
      proposalId,
      sourceRepo: "acme/web",
      sourcePr: 42,
      sourcePrTitle: "Split auth",
      sourceSha: "deadbee",
      autoAssigned: true,
      needsOwner: false,
    });
    expect(body).toContain(baseProposal.rationale);
    expect(body).toContain(baseProposal.suggested_node_body_markdown);
  });
});

describe("sync --open-issues · runOpenIssuesMode", () => {
  it("finds existing proposal issues even when the repo has no seeded labels", async () => {
    const previousToken = process.env.TREE_REPO_TOKEN;
    process.env.TREE_REPO_TOKEN = "tree-token";

    const treeRoot = mkdtempSync(join(tmpdir(), "first-tree-sync-open-issues-"));
    mkdirSync(join(treeRoot, baseProposal.path), { recursive: true });

    const calls: Array<{
      command: string;
      args: string[];
      envToken?: string;
    }> = [];

    try {
      const exitCode = await runOpenIssuesMode({
        drift: {
          binding: { sourceId: "acme-web" },
          ownerRepo: { owner: "acme", repo: "web" },
        },
        classifiedPrs: [{
          pr: {
            number: 42,
            title: "Split auth",
            mergeCommitSha: "deadbeefcafebabe",
            authorLogin: "octocat",
          },
          filtered: [baseProposal],
        }],
        treeRoot,
        shellRun: async (command, args, options = {}) => {
          calls.push({
            command,
            args: [...args],
            envToken: options.env?.GH_TOKEN,
          });

          if (command !== "gh") {
            return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
          }
          if (args[0] === "repo" && args[1] === "view") {
            return { code: 0, stdout: "agent-team-foundation/first-tree-context\n", stderr: "" };
          }
          if (args[0] === "issue" && args[1] === "list") {
            return {
              code: 0,
              stdout: JSON.stringify([
                { url: "https://github.com/agent-team-foundation/first-tree-context/issues/123" },
              ]),
              stderr: "",
            };
          }
          if (args[0] === "issue" && args[1] === "create") {
            return {
              code: 0,
              stdout: "https://github.com/agent-team-foundation/first-tree-context/issues/124\n",
              stderr: "",
            };
          }
          return { code: 1, stdout: "", stderr: `unexpected gh args: ${args.join(" ")}` };
        },
        dryRun: false,
      });

      expect(exitCode).toBe(0);

      const issueListCall = calls.find((call) =>
        call.command === "gh" && call.args[0] === "issue" && call.args[1] === "list"
      );
      expect(issueListCall).toBeDefined();
      expect(issueListCall?.args).not.toContain("--label");
      expect(issueListCall?.envToken).toBe("tree-token");

      const issueCreateCall = calls.find((call) =>
        call.command === "gh" && call.args[0] === "issue" && call.args[1] === "create"
      );
      expect(issueCreateCall).toBeUndefined();
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
      if (previousToken === undefined) {
        delete process.env.TREE_REPO_TOKEN;
      } else {
        process.env.TREE_REPO_TOKEN = previousToken;
      }
    }
  });

  it("files the issue unassigned with needs-owner when the node's owners: is empty, even when the PR author exists (#280)", async () => {
    const previousToken = process.env.TREE_REPO_TOKEN;
    process.env.TREE_REPO_TOKEN = "tree-token";

    const treeRoot = mkdtempSync(join(tmpdir(), "first-tree-sync-open-issues-needs-owner-"));
    const nodeDir = join(treeRoot, baseProposal.path);
    mkdirSync(nodeDir, { recursive: true });
    // NODE.md exists with an empty owners: list — this is the case #280 targets.
    writeFileSync(
      join(nodeDir, "NODE.md"),
      "---\ntitle: \"Auth service\"\nowners: []\n---\n\nBody.\n",
    );

    const calls: Array<{ command: string; args: string[] }> = [];

    try {
      const exitCode = await runOpenIssuesMode({
        drift: {
          binding: { sourceId: "acme-web" },
          ownerRepo: { owner: "acme", repo: "web" },
        },
        classifiedPrs: [{
          pr: {
            number: 42,
            title: "Split auth",
            mergeCommitSha: "deadbeefcafebabe",
            // PR author is set — previous behaviour would have assigned them.
            authorLogin: "octocat",
          },
          filtered: [baseProposal],
        }],
        treeRoot,
        shellRun: async (command, args) => {
          calls.push({ command, args: [...args] });
          if (command !== "gh") {
            return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
          }
          if (args[0] === "repo" && args[1] === "view") {
            return { code: 0, stdout: "agent-team-foundation/first-tree-context\n", stderr: "" };
          }
          if (args[0] === "issue" && args[1] === "list") {
            return { code: 0, stdout: "[]", stderr: "" };
          }
          if (args[0] === "issue" && args[1] === "create") {
            return {
              code: 0,
              stdout: "https://github.com/agent-team-foundation/first-tree-context/issues/777\n",
              stderr: "",
            };
          }
          return { code: 1, stdout: "", stderr: `unexpected gh args: ${args.join(" ")}` };
        },
        dryRun: false,
      });

      expect(exitCode).toBe(0);

      const createCall = calls.find(
        (c) => c.command === "gh" && c.args[0] === "issue" && c.args[1] === "create",
      );
      expect(createCall).toBeDefined();
      // No PR-author fallback: --assignee must not be set.
      expect(createCall?.args).not.toContain("--assignee");
      expect(createCall?.args.some((a) => a.includes("octocat"))).toBe(false);
      // The needs-owner label must be applied instead.
      const labelIdx = createCall?.args.indexOf("--label") ?? -1;
      expect(labelIdx).toBeGreaterThanOrEqual(0);
      expect(createCall?.args[labelIdx + 1]).toContain("needs-owner");
      // And the body should surface the needs-owner copy.
      const bodyIdx = createCall?.args.indexOf("--body") ?? -1;
      expect(bodyIdx).toBeGreaterThanOrEqual(0);
      expect(createCall?.args[bodyIdx + 1].toLowerCase()).toContain("needs-owner");
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
      if (previousToken === undefined) {
        delete process.env.TREE_REPO_TOKEN;
      } else {
        process.env.TREE_REPO_TOKEN = previousToken;
      }
    }
  });

  it("rebuilds the issue body after the assignee-strip retry so needs-owner is reflected in body copy too", async () => {
    const previousToken = process.env.TREE_REPO_TOKEN;
    process.env.TREE_REPO_TOKEN = "tree-token";

    const treeRoot = mkdtempSync(join(tmpdir(), "first-tree-sync-open-issues-body-rebuild-"));
    const nodeDir = join(treeRoot, baseProposal.path);
    mkdirSync(nodeDir, { recursive: true });
    // NODE.md has a real owner — initial create will attempt --assignee.
    writeFileSync(
      join(nodeDir, "NODE.md"),
      "---\ntitle: \"Auth service\"\nowners: [not-a-collaborator]\n---\n\nBody.\n",
    );

    const createCalls: string[][] = [];

    try {
      const exitCode = await runOpenIssuesMode({
        drift: {
          binding: { sourceId: "acme-web" },
          ownerRepo: { owner: "acme", repo: "web" },
        },
        classifiedPrs: [{
          pr: {
            number: 42,
            title: "Split auth",
            mergeCommitSha: "deadbeefcafebabe",
            authorLogin: "octocat",
          },
          filtered: [baseProposal],
        }],
        treeRoot,
        shellRun: async (command, args) => {
          if (command !== "gh") {
            return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
          }
          if (args[0] === "repo" && args[1] === "view") {
            return { code: 0, stdout: "agent-team-foundation/first-tree-context\n", stderr: "" };
          }
          if (args[0] === "issue" && args[1] === "list") {
            return { code: 0, stdout: "[]", stderr: "" };
          }
          if (args[0] === "issue" && args[1] === "create") {
            createCalls.push([...args]);
            // First attempt: 422 because assignee isn't a collaborator.
            if (createCalls.length === 1) {
              return {
                code: 1,
                stdout: "",
                stderr: "Validation Failed: assignee not-a-collaborator is not a collaborator",
              };
            }
            // Retry without --assignee succeeds.
            return {
              code: 0,
              stdout: "https://github.com/agent-team-foundation/first-tree-context/issues/888\n",
              stderr: "",
            };
          }
          return { code: 1, stdout: "", stderr: `unexpected gh args: ${args.join(" ")}` };
        },
        dryRun: false,
      });

      expect(exitCode).toBe(0);
      expect(createCalls.length).toBe(2);

      // Initial attempt carried --assignee and a body claiming auto-assignment.
      const firstArgs = createCalls[0];
      expect(firstArgs).toContain("--assignee");
      const firstBody = firstArgs[firstArgs.indexOf("--body") + 1];
      expect(firstBody.toLowerCase()).toContain("assigned to node owners");
      expect(firstBody.toLowerCase()).not.toContain("no `owners:`");

      // Retry: --assignee gone, --label includes needs-owner, body rebuilt to
      // match the final (unassigned / needs-owner) state — no lingering
      // "assigned to node owners" copy.
      const retryArgs = createCalls[1];
      expect(retryArgs).not.toContain("--assignee");
      const labelIdx = retryArgs.indexOf("--label");
      expect(labelIdx).toBeGreaterThanOrEqual(0);
      expect(retryArgs[labelIdx + 1]).toContain("needs-owner");
      const retryBody = retryArgs[retryArgs.indexOf("--body") + 1];
      expect(retryBody.toLowerCase()).toContain("no `owners:`");
      expect(retryBody.toLowerCase()).toContain("filing unassigned");
      expect(retryBody.toLowerCase()).not.toContain("assigned to node owners");
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
      if (previousToken === undefined) {
        delete process.env.TREE_REPO_TOKEN;
      } else {
        process.env.TREE_REPO_TOKEN = previousToken;
      }
    }
  });

  interface RunArgs {
    shell: (
      command: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
    dryRun?: boolean;
    token?: string | null;
  }

  async function runWithHarness({ shell, dryRun = false, token = "tree-token" }: RunArgs) {
    const previousToken = process.env.TREE_REPO_TOKEN;
    if (token === null) {
      delete process.env.TREE_REPO_TOKEN;
    } else {
      process.env.TREE_REPO_TOKEN = token;
    }
    const treeRoot = mkdtempSync(join(tmpdir(), "first-tree-sync-open-issues-"));
    const nodeDir = join(treeRoot, baseProposal.path);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(
      join(nodeDir, "NODE.md"),
      "---\ntitle: \"Auth\"\nowners: [alice]\n---\n\nBody.\n",
    );
    const calls: Array<{ command: string; args: string[]; envToken?: string }> = [];
    try {
      const exitCode = await runOpenIssuesMode({
        drift: {
          binding: { sourceId: "acme-web" },
          ownerRepo: { owner: "acme", repo: "web" },
        },
        classifiedPrs: [
          {
            pr: {
              number: 42,
              title: "Split auth",
              mergeCommitSha: "deadbeefcafebabe",
              authorLogin: "octocat",
            },
            filtered: [baseProposal],
          },
        ],
        treeRoot,
        shellRun: async (command, args, options = {}) => {
          calls.push({
            command,
            args: [...args],
            envToken: options.env?.GH_TOKEN,
          });
          return shell(command, args, options);
        },
        dryRun,
      });
      return { exitCode, calls };
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
      if (previousToken === undefined) {
        delete process.env.TREE_REPO_TOKEN;
      } else {
        process.env.TREE_REPO_TOKEN = previousToken;
      }
    }
  }

  it("happy path: one `gh issue create` call with proposal_id in body and GH_TOKEN threaded", async () => {
    const { exitCode, calls } = await runWithHarness({
      shell: async (_cmd, args) => {
        if (args[0] === "repo" && args[1] === "view") {
          return { code: 0, stdout: "agent-team-foundation/tree\n", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "list") {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "create") {
          return { code: 0, stdout: "https://github.com/org/tree/issues/1\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
      },
    });
    expect(exitCode).toBe(0);
    const createCalls = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
    expect(createCalls).toHaveLength(1);
    const createCall = createCalls[0];
    expect(createCall.envToken).toBe("tree-token");
    const bodyIdx = createCall.args.indexOf("--body");
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(createCall.args[bodyIdx + 1]).toContain("proposal_id=");
    expect(createCall.args).toContain("first-tree:sync-proposal,gardener");
    // Prove the assignee-routing path: --assignee must be threaded as the
    // unquoted login from NODE.md, not the literal quoted form.
    const assigneeIdx = createCall.args.indexOf("--assignee");
    expect(assigneeIdx).toBeGreaterThan(-1);
    expect(createCall.args[assigneeIdx + 1]).toBe("alice");
  });

  it("retries without --label when gh rejects unknown labels (422)", async () => {
    let createAttempts = 0;
    const { exitCode, calls } = await runWithHarness({
      shell: async (_cmd, args) => {
        if (args[0] === "repo" && args[1] === "view") {
          return { code: 0, stdout: "org/tree\n", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "list") {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "create") {
          createAttempts += 1;
          if (createAttempts === 1) {
            return { code: 1, stdout: "", stderr: "422 Unprocessable: label not found" };
          }
          return { code: 0, stdout: "https://github.com/org/tree/issues/1\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
      },
    });
    expect(exitCode).toBe(0);
    const createCalls = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0].args).toContain("--label");
    expect(createCalls[1].args).not.toContain("--label");
    // Assignee-routing is preserved across the label-strip retry.
    for (const call of createCalls) {
      const idx = call.args.indexOf("--assignee");
      expect(idx).toBeGreaterThan(-1);
      expect(call.args[idx + 1]).toBe("alice");
    }
  });

  it("retries without --assignee and adds needs-owner when assignee is rejected (422)", async () => {
    // Attempt 1 (with --label + --assignee) fails 422 → code tries label-strip first.
    // Attempt 2 (with --assignee, no --label) still fails 422 on assignee → code strips assignee.
    // Attempt 3 (no --assignee, with --label including needs-owner) succeeds.
    let createAttempts = 0;
    const { exitCode, calls } = await runWithHarness({
      shell: async (_cmd, args) => {
        if (args[0] === "repo" && args[1] === "view") {
          return { code: 0, stdout: "org/tree\n", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "list") {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "create") {
          createAttempts += 1;
          if (createAttempts <= 2) {
            return {
              code: 1,
              stdout: "",
              stderr: "422 Unprocessable: assignee not a collaborator",
            };
          }
          return { code: 0, stdout: "https://github.com/org/tree/issues/1\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
      },
    });
    expect(exitCode).toBe(0);
    const createCalls = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
    expect(createCalls).toHaveLength(3);
    const retry = createCalls[2];
    expect(retry.args).not.toContain("--assignee");
    const labelIdx = retry.args.indexOf("--label");
    expect(labelIdx).toBeGreaterThan(-1);
    expect(retry.args[labelIdx + 1]).toContain("needs-owner");
  });

  it("dry-run skips `gh issue create` but still resolves the tree slug", async () => {
    const { exitCode, calls } = await runWithHarness({
      dryRun: true,
      shell: async (_cmd, args) => {
        if (args[0] === "repo" && args[1] === "view") {
          return { code: 0, stdout: "org/tree\n", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "list") {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
      },
    });
    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.args[0] === "repo" && c.args[1] === "view")).toBe(true);
    expect(calls.some((c) => c.args[0] === "issue" && c.args[1] === "create")).toBe(false);
  });

  it("fails fast when TREE_REPO_TOKEN is unset", async () => {
    const { exitCode, calls } = await runWithHarness({
      token: null,
      shell: async () => ({ code: 1, stdout: "", stderr: "should not be called" }),
    });
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("seeds gardener labels on the tree repo before the first issue create (#303)", async () => {
    const previousToken = process.env.TREE_REPO_TOKEN;
    process.env.TREE_REPO_TOKEN = "tree-token";

    const treeRoot = mkdtempSync(
      join(tmpdir(), "first-tree-sync-open-issues-label-seed-"),
    );
    mkdirSync(join(treeRoot, baseProposal.path), { recursive: true });

    const labelCreateCalls: string[][] = [];
    const issueCreateCalls: string[][] = [];

    try {
      const exitCode = await runOpenIssuesMode({
        drift: {
          binding: { sourceId: "acme-web" },
          ownerRepo: { owner: "acme", repo: "web" },
        },
        classifiedPrs: [{
          pr: {
            number: 42,
            title: "Split auth",
            mergeCommitSha: "deadbeefcafebabe",
            authorLogin: "octocat",
          },
          filtered: [baseProposal],
        }],
        treeRoot,
        shellRun: async (command, args) => {
          if (command !== "gh") {
            return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
          }
          if (args[0] === "repo" && args[1] === "view") {
            return { code: 0, stdout: "agent-team-foundation/first-tree-context\n", stderr: "" };
          }
          if (args[0] === "label" && args[1] === "create") {
            labelCreateCalls.push([...args]);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "issue" && args[1] === "list") {
            return { code: 0, stdout: "[]", stderr: "" };
          }
          if (args[0] === "issue" && args[1] === "create") {
            issueCreateCalls.push([...args]);
            return {
              code: 0,
              stdout: "https://github.com/agent-team-foundation/first-tree-context/issues/999\n",
              stderr: "",
            };
          }
          return { code: 1, stdout: "", stderr: `unexpected gh args: ${args.join(" ")}` };
        },
        dryRun: false,
      });

      expect(exitCode).toBe(0);

      const seededLabelNames = labelCreateCalls.map((args) => args[2]);
      expect(seededLabelNames).toContain("first-tree:sync-proposal");
      expect(seededLabelNames).toContain("gardener");
      expect(seededLabelNames).toContain("needs-owner");

      expect(issueCreateCalls).toHaveLength(1);
      const issueArgs = issueCreateCalls[0];
      const labelIdx = issueArgs.indexOf("--label");
      expect(labelIdx).toBeGreaterThanOrEqual(0);
      expect(issueArgs[labelIdx + 1]).toContain("first-tree:sync-proposal");
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
      if (previousToken === undefined) {
        delete process.env.TREE_REPO_TOKEN;
      } else {
        process.env.TREE_REPO_TOKEN = previousToken;
      }
    }
  });

  it("treats 'label already exists' on seed as success and still applies labels on issue create (#303)", async () => {
    const previousToken = process.env.TREE_REPO_TOKEN;
    process.env.TREE_REPO_TOKEN = "tree-token";

    const treeRoot = mkdtempSync(
      join(tmpdir(), "first-tree-sync-open-issues-label-exists-"),
    );
    mkdirSync(join(treeRoot, baseProposal.path), { recursive: true });

    const issueCreateCalls: string[][] = [];

    try {
      const exitCode = await runOpenIssuesMode({
        drift: {
          binding: { sourceId: "acme-web" },
          ownerRepo: { owner: "acme", repo: "web" },
        },
        classifiedPrs: [{
          pr: {
            number: 42,
            title: "Split auth",
            mergeCommitSha: "deadbeefcafebabe",
            authorLogin: "octocat",
          },
          filtered: [baseProposal],
        }],
        treeRoot,
        shellRun: async (command, args) => {
          if (command !== "gh") {
            return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
          }
          if (args[0] === "repo" && args[1] === "view") {
            return { code: 0, stdout: "agent-team-foundation/first-tree-context\n", stderr: "" };
          }
          if (args[0] === "label" && args[1] === "create") {
            return {
              code: 1,
              stdout: "",
              stderr: "HTTP 422: Validation Failed (already exists)",
            };
          }
          if (args[0] === "issue" && args[1] === "list") {
            return { code: 0, stdout: "[]", stderr: "" };
          }
          if (args[0] === "issue" && args[1] === "create") {
            issueCreateCalls.push([...args]);
            return {
              code: 0,
              stdout: "https://github.com/agent-team-foundation/first-tree-context/issues/1000\n",
              stderr: "",
            };
          }
          return { code: 1, stdout: "", stderr: `unexpected gh args: ${args.join(" ")}` };
        },
        dryRun: false,
      });

      expect(exitCode).toBe(0);
      expect(issueCreateCalls).toHaveLength(1);
      const issueArgs = issueCreateCalls[0];
      expect(issueArgs).toContain("--label");
      // First attempt should carry the label — no retry-without-label was needed.
      const labelIdx = issueArgs.indexOf("--label");
      expect(issueArgs[labelIdx + 1]).toContain("first-tree:sync-proposal");
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
      if (previousToken === undefined) {
        delete process.env.TREE_REPO_TOKEN;
      } else {
        process.env.TREE_REPO_TOKEN = previousToken;
      }
    }
  });
});
