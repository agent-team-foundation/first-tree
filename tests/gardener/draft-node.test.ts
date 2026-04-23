import { describe, expect, it, vi } from "vitest";

import {
  DRAFT_NODE_USAGE,
  draftBranchName,
  draftCommitMessage,
  draftPrBody,
  draftPrTitle,
  extractProposedContent,
  parseFlags,
  parseProposalMarker,
  runDraftNode,
} from "#products/gardener/engine/draft-node.js";

type ShellCall = {
  command: string;
  args: string[];
  options?: { cwd?: string; env?: NodeJS.ProcessEnv };
};

describe("gardener draft-node · parseFlags", () => {
  it("parses --issue --tree-repo --tree-path --dry-run", () => {
    const flags = parseFlags([
      "--issue",
      "42",
      "--tree-repo",
      "agent-team-foundation/first-tree-context",
      "--tree-path",
      "../tree",
      "--dry-run",
    ]);
    expect(flags).toMatchObject({
      issue: 42,
      treeRepo: "agent-team-foundation/first-tree-context",
      treePath: "../tree",
      dryRun: true,
      help: false,
      unknown: null,
    });
  });

  it("flags --help / -h", () => {
    expect(parseFlags(["--help"]).help).toBe(true);
    expect(parseFlags(["-h"]).help).toBe(true);
  });

  it("rejects non-integer --issue", () => {
    const flags = parseFlags(["--issue", "abc"]);
    expect(flags.issue).toBe(null);
    expect(flags.unknown).toMatch(/--issue/);
  });

  it("rejects zero or negative --issue", () => {
    expect(parseFlags(["--issue", "0"]).unknown).toMatch(/--issue/);
    expect(parseFlags(["--issue", "-3"]).unknown).toMatch(/--issue/);
  });

  it("rejects malformed --tree-repo", () => {
    expect(parseFlags(["--tree-repo", "no-slash"]).unknown).toMatch(/--tree-repo/);
    expect(parseFlags(["--tree-repo", "a/b/c"]).unknown).toMatch(/--tree-repo/);
  });

  it("reports unknown flags", () => {
    const flags = parseFlags(["--issue", "5", "--nonsense"]);
    expect(flags.unknown).toBe("--nonsense");
  });
});

describe("gardener draft-node · parseProposalMarker", () => {
  it("parses the sync variant with three required fields", () => {
    const body =
      "<!-- gardener:sync-proposal · proposal_id=abc123def456 · source_sha=deadbeef · node=engineering/backend/auth -->\n\n" +
      "Proposed tree update for `engineering/backend/auth`.\n";
    const marker = parseProposalMarker(body);
    expect(marker).toEqual({
      proposalId: "abc123def456",
      sourceSha: "deadbeef",
      node: "engineering/backend/auth",
      source: null,
      sourcePr: null,
    });
  });

  it("parses the merged-PR variant with source= and source_pr= fields", () => {
    const body =
      "<!-- gardener:sync-proposal · proposal_id=0000ffff1111 · source_sha=abcd1234 · node=pkg-a · source=merged-pr · source_pr=alice/cool#207 -->\n";
    const marker = parseProposalMarker(body);
    expect(marker).toMatchObject({
      proposalId: "0000ffff1111",
      sourceSha: "abcd1234",
      node: "pkg-a",
      source: "merged-pr",
      sourcePr: "alice/cool#207",
    });
  });

  it("returns null for bodies without a marker", () => {
    expect(parseProposalMarker("just a body, no marker")).toBe(null);
  });

  it("returns null when required fields are missing", () => {
    // proposal_id absent
    expect(
      parseProposalMarker(
        "<!-- gardener:sync-proposal · source_sha=x · node=y -->",
      ),
    ).toBe(null);
    // node absent
    expect(
      parseProposalMarker(
        "<!-- gardener:sync-proposal · proposal_id=x · source_sha=y -->",
      ),
    ).toBe(null);
  });

  it("tolerates source_sha=unknown", () => {
    const body =
      "<!-- gardener:sync-proposal · proposal_id=aa · source_sha=unknown · node=p -->";
    const marker = parseProposalMarker(body);
    expect(marker?.sourceSha).toBe("unknown");
  });
});

describe("gardener draft-node · extractProposedContent", () => {
  it("extracts content between the header and the --- separator", () => {
    const body = [
      "<!-- marker -->",
      "",
      "Proposed tree update for `pkg-a`.",
      "",
      "### Rationale",
      "Because reasons.",
      "",
      "### Proposed node content",
      "---",
      "owners: [alice]",
      "---",
      "",
      "# Auth module",
      "",
      "Handles signin.",
      "",
      "---",
      "Filed by sync.",
    ].join("\n");
    const extracted = extractProposedContent(body);
    expect(extracted).toContain("owners: [alice]");
    expect(extracted).toContain("# Auth module");
    expect(extracted).toContain("Handles signin.");
    expect(extracted).not.toContain("Filed by sync.");
  });

  it("returns null when no proposed-content section exists", () => {
    const body = "<!-- marker -->\n\nJust a description of the change.";
    expect(extractProposedContent(body)).toBe(null);
  });

  it("handles body where proposed content ends at EOF (no --- separator)", () => {
    const body =
      "### Proposed node content\n# Title\n\nBody text without a trailing separator.";
    const extracted = extractProposedContent(body);
    expect(extracted).toContain("# Title");
    expect(extracted).toContain("Body text without a trailing separator.");
  });
});

describe("gardener draft-node · derived strings", () => {
  it("draftBranchName is deterministic from proposal id", () => {
    expect(draftBranchName("abc123")).toBe("first-tree/draft-node-abc123");
  });

  it("draftCommitMessage includes node and proposal id", () => {
    expect(draftCommitMessage("engineering/backend", "abc123")).toBe(
      "chore(tree): draft engineering/backend from proposal abc123",
    );
  });

  it("draftPrTitle includes node", () => {
    expect(draftPrTitle("pkg-a")).toBe("[gardener] draft pkg-a");
  });

  it("draftPrBody shows source PR link when marker has source_pr", () => {
    const body = draftPrBody({
      issueNumber: 42,
      treeRepo: "org/tree",
      marker: {
        proposalId: "abc",
        sourceSha: "dead",
        node: "pkg-a",
        source: "merged-pr",
        sourcePr: "alice/cool#207",
      },
    });
    expect(body).toContain("org/tree#42");
    expect(body).toContain("**Source PR:** alice/cool#207");
    expect(body).toContain("Closes org/tree#42 on merge.");
  });

  it("draftPrBody falls back to source SHA when source_pr absent", () => {
    const body = draftPrBody({
      issueNumber: 42,
      treeRepo: "org/tree",
      marker: {
        proposalId: "abc",
        sourceSha: "dead",
        node: "pkg-a",
        source: null,
        sourcePr: null,
      },
    });
    expect(body).toContain("**Source SHA:** dead");
  });
});

describe("gardener draft-node · runDraftNode integration (mocked shell)", () => {
  it("emits BREEZE_RESULT skipped when TREE_REPO_TOKEN is unset", async () => {
    const lines: string[] = [];
    const code = await runDraftNode(
      ["--issue", "1", "--tree-repo", "org/tree"],
      {
        write: (line) => lines.push(line),
        env: {},
        cwd: "/tmp",
        shell: vi.fn(),
      },
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("BREEZE_RESULT: status=skipped"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("TREE_REPO_TOKEN unset"))).toBe(true);
  });

  it("emits failed when --issue is missing", async () => {
    const lines: string[] = [];
    const code = await runDraftNode([], {
      write: (line) => lines.push(line),
      env: { TREE_REPO_TOKEN: "t" },
      cwd: "/tmp",
      shell: vi.fn(),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("BREEZE_RESULT: status=failed"))).toBe(
      true,
    );
  });

  it("emits skipped when issue has no gardener:sync-proposal marker", async () => {
    const lines: string[] = [];
    const shell = vi.fn(async () => ({
      stdout: "Just an issue body with no marker.\n",
      stderr: "",
      code: 0,
    }));
    const code = await runDraftNode(
      ["--issue", "5", "--tree-repo", "org/tree"],
      {
        write: (line) => lines.push(line),
        env: { TREE_REPO_TOKEN: "t" },
        cwd: "/tmp",
        shell,
      },
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("BREEZE_RESULT: status=skipped"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("no sync-proposal marker"))).toBe(true);
  });

  it("dry-run previews the plan without invoking git/gh", async () => {
    const lines: string[] = [];
    const issueBody = [
      "<!-- gardener:sync-proposal · proposal_id=aa11bb22 · source_sha=dead · node=pkg-a -->",
      "",
      "### Proposed node content",
      "# Pkg A",
      "",
      "Body.",
      "",
      "---",
      "Filed.",
    ].join("\n");
    const shell = vi.fn(async () => ({
      stdout: issueBody,
      stderr: "",
      code: 0,
    }));
    const code = await runDraftNode(
      ["--issue", "7", "--tree-repo", "org/tree", "--dry-run"],
      {
        write: (line) => lines.push(line),
        env: { TREE_REPO_TOKEN: "t" },
        cwd: "/tmp",
        shell,
      },
    );
    expect(code).toBe(0);
    expect(shell).toHaveBeenCalledTimes(1); // only the gh issue view call
    expect(lines.some((l) => l.includes("would branch: first-tree/draft-node-aa11bb22"))).toBe(true);
    expect(lines.some((l) => l.includes("BREEZE_RESULT: status=skipped"))).toBe(true);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
  });

  it("reuses an existing remote draft branch before checking for staged changes", async () => {
    const calls: ShellCall[] = [];
    const lines: string[] = [];
    const issueBody = [
      "<!-- gardener:sync-proposal · proposal_id=aa11bb22 · source_sha=dead · node=pkg-a -->",
      "",
      "### Proposed node content",
      "# Pkg A",
      "",
      "Body.",
      "",
      "---",
      "Filed.",
    ].join("\n");
    const shell = vi.fn(async (command: string, args: string[], options?: ShellCall["options"]) => {
      calls.push({ command, args, options });
      if (command === "gh" && args[0] === "issue") {
        return { stdout: issueBody, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: "", stderr: "unknown revision", code: 1 };
      }
      if (command === "git" && args[0] === "fetch") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "checkout") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "add") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "diff") {
        return { stdout: "", stderr: "", code: 0 };
      }
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    });

    const code = await runDraftNode(
      ["--issue", "7", "--tree-repo", "org/tree"],
      {
        write: (line) => lines.push(line),
        env: { TREE_REPO_TOKEN: "secret-token" },
        cwd: "/tmp",
        shell,
      },
    );

    expect(code).toBe(0);

    const issueView = calls.find((call) => call.command === "gh" && call.args[0] === "issue");
    expect(issueView?.options?.env?.GH_TOKEN).toBe("secret-token");

    const fetchIndex = calls.findIndex(
      (call) => call.command === "git" && call.args[0] === "fetch",
    );
    const checkoutIndex = calls.findIndex(
      (call) => call.command === "git" && call.args[0] === "checkout",
    );
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(checkoutIndex).toBeGreaterThan(fetchIndex);
    expect(calls[checkoutIndex]?.args).toEqual([
      "checkout",
      "-B",
      "first-tree/draft-node-aa11bb22",
      "FETCH_HEAD",
    ]);
    expect(lines.some((line) => line.includes("already applied"))).toBe(true);
    expect(lines.some((line) => line.includes("BREEZE_RESULT: status=skipped"))).toBe(true);
  });

  it("DRAFT_NODE_USAGE mentions --issue and TREE_REPO_TOKEN", () => {
    expect(DRAFT_NODE_USAGE).toContain("--issue");
    expect(DRAFT_NODE_USAGE).toContain("TREE_REPO_TOKEN");
    expect(DRAFT_NODE_USAGE).toContain("gardener:sync-proposal");
  });
});
