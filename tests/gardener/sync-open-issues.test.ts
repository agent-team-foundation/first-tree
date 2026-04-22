import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSyncProposalBody,
  computeProposalId,
  runOpenIssuesMode,
  type ClassificationItem,
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
});
