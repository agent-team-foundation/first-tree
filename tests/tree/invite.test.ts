import { describe, expect, it } from "vitest";
import {
  parseInviteArgs,
  composeMagicWord,
  readTreeContext,
  sanitizeInviteTreeUrl,
  type TreeContext,
} from "#products/tree/engine/invite.js";
import {
  renderInviteMemberNode,
  type InviteMemberInput,
} from "#products/tree/engine/member-seeding.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTmpDir } from "../helpers.js";

const MEMBER_TEMPLATE = [
  "---",
  'title: "<Display Name>"',
  "owners: [<github-username>]",
  'type: "<human | personal_assistant | autonomous_agent>"',
  'role: "<role title>"',
  "domains:",
  '  - "<domain>"',
  "---",
  "",
  "# <Display Name>",
  "",
  "## About",
  "",
  "<!-- Who you are and what you bring to the team. -->",
  "",
  "## Current Focus",
  "",
  "<!-- What you're actively working on. -->",
  "",
].join("\n");

// --- parseInviteArgs ---

describe("parseInviteArgs", () => {
  it("parses all required flags", () => {
    const result = parseInviteArgs([
      "--github-id",
      "alice",
      "--type",
      "human",
    ]);
    expect(result).toEqual({
      branch: true,
      pr: false,
      githubId: "alice",
      type: "human",
    });
  });

  it("parses all optional flags", () => {
    const result = parseInviteArgs([
      "--github-id",
      "alice",
      "--type",
      "autonomous_agent",
      "--title",
      "Alice Bot",
      "--role",
      "CI Agent",
      "--domains",
      "ci,deployment",
      "--delegate-mention",
      "alice-assistant",
      "--tree-path",
      "/tmp/tree",
      "--no-branch",
      "--pr",
    ]);
    expect(result).toEqual({
      branch: false,
      pr: true,
      githubId: "alice",
      type: "autonomous_agent",
      title: "Alice Bot",
      role: "CI Agent",
      domains: ["ci", "deployment"],
      delegateMention: "alice-assistant",
      treePath: "/tmp/tree",
    });
  });

  it("returns error for missing --github-id", () => {
    const result = parseInviteArgs(["--type", "human"]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/--github-id/);
  });

  it("returns error for missing --type", () => {
    const result = parseInviteArgs(["--github-id", "alice"]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/--type/);
  });

  it("returns error for invalid type", () => {
    const result = parseInviteArgs([
      "--github-id",
      "alice",
      "--type",
      "robot",
    ]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/Invalid type/);
  });

  it("returns error for unknown flag", () => {
    const result = parseInviteArgs([
      "--github-id",
      "alice",
      "--type",
      "human",
      "--unknown",
    ]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/Unknown option/);
  });
});

// --- renderInviteMemberNode ---

describe("renderInviteMemberNode", () => {
  it("renders a human invite node with status: invited", () => {
    const input: InviteMemberInput = {
      githubId: "alice",
      title: "Alice",
      type: "human",
      role: "Engineer",
      domains: ["backend"],
    };
    const result = renderInviteMemberNode(MEMBER_TEMPLATE, input);

    expect(result).toContain('title: "Alice"');
    expect(result).toContain("owners: [alice]");
    expect(result).toContain('type: "human"');
    expect(result).toContain('status: "invited"');
    expect(result).toContain('role: "Engineer"');
    expect(result).toContain('- "backend"');
    expect(result).toContain("# Alice");
    // Should keep template placeholders for About/Current Focus
    expect(result).toContain("<!-- Who you are and what you bring to the team. -->");
    expect(result).toContain("<!-- What you're actively working on. -->");
  });

  it("renders multiple domains", () => {
    const input: InviteMemberInput = {
      githubId: "bob",
      title: "Bob",
      type: "autonomous_agent",
      role: "CI Agent",
      domains: ["ci", "deployment", "monitoring"],
    };
    const result = renderInviteMemberNode(MEMBER_TEMPLATE, input);

    expect(result).toContain('- "ci"');
    expect(result).toContain('- "deployment"');
    expect(result).toContain('- "monitoring"');
  });

  it("includes delegate_mention when provided", () => {
    const input: InviteMemberInput = {
      githubId: "charlie",
      title: "Charlie",
      type: "human",
      role: "PM",
      domains: ["product"],
      delegateMention: "charlie-assistant",
    };
    const result = renderInviteMemberNode(MEMBER_TEMPLATE, input);

    expect(result).toContain('delegate_mention: "charlie-assistant"');
  });

  it("does not include delegate_mention when omitted", () => {
    const input: InviteMemberInput = {
      githubId: "dave",
      title: "Dave",
      type: "human",
      role: "Eng",
      domains: ["infra"],
    };
    const result = renderInviteMemberNode(MEMBER_TEMPLATE, input);

    expect(result).not.toContain("delegate_mention");
  });

  it("status: invited appears after type line", () => {
    const input: InviteMemberInput = {
      githubId: "eve",
      title: "Eve",
      type: "personal_assistant",
      role: "Assistant",
      domains: ["support"],
    };
    const result = renderInviteMemberNode(MEMBER_TEMPLATE, input);
    const lines = result.split("\n");

    const typeLine = lines.findIndex((l) => l.startsWith('type: '));
    const statusLine = lines.findIndex((l) => l.startsWith('status: '));
    expect(typeLine).toBeGreaterThan(-1);
    expect(statusLine).toBe(typeLine + 1);
  });
});

// --- composeMagicWord ---

describe("composeMagicWord", () => {
  it("generates a complete invite block", () => {
    const ctx: TreeContext = {
      title: "My Org Context",
      description: "The shared memory for decisions and coordination.",
      repositories: ["backend-api", "frontend-app", "infra"],
      inviterDisplay: "@alice",
    };
    const result = composeMagicWord(
      ctx,
      "https://github.com/org/my-org-context.git",
      "bob",
      "invite/bob",
    );

    expect(result).toContain("--- First Tree Invite ---");
    expect(result).toContain("--- End Invite ---");
    expect(result).toContain("@alice has invited you to join a Context Tree.");
    expect(result).toContain('"My Org Context"');
    expect(result).toContain("The shared memory for decisions and coordination.");
    expect(result).toContain("- backend-api");
    expect(result).toContain("- frontend-app");
    expect(result).toContain("- infra");
    expect(result).toContain(
      "npx first-tree join --tree-url https://github.com/org/my-org-context.git --invite bob --branch invite/bob",
    );
  });

  it("omits repositories section when empty", () => {
    const ctx: TreeContext = {
      title: "Small Tree",
      description: "A tiny tree.",
      repositories: [],
      inviterDisplay: "A team member",
    };
    const result = composeMagicWord(
      ctx,
      "https://example.com/tree.git",
      "charlie",
      "main",
    );

    expect(result).not.toContain("## What repositories does it cover?");
    expect(result).toContain("npx first-tree join");
  });
});

describe("sanitizeInviteTreeUrl", () => {
  it("strips embedded credentials from https remotes", () => {
    expect(
      sanitizeInviteTreeUrl("https://token:x-oauth-basic@github.com/org/tree.git"),
    ).toBe("https://github.com/org/tree.git");
  });

  it("converts ssh remotes into shareable https urls", () => {
    expect(sanitizeInviteTreeUrl("git@github.com:org/tree.git")).toBe(
      "https://github.com/org/tree.git",
    );
  });
});

// --- readTreeContext ---

describe("readTreeContext", () => {
  it("extracts title and description from NODE.md", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      [
        "---",
        "title: Test Tree",
        "owners: [alice]",
        "---",
        "",
        "# Test Tree",
        "",
        "This tree tracks decisions for our org.",
        "",
        "## Domains",
        "",
        "- **[backend/](backend/NODE.md)** — API services.",
        "- **[frontend/](frontend/NODE.md)** — Web app.",
        "",
      ].join("\n"),
    );

    const ctx = readTreeContext(tmp.path);
    expect(ctx.title).toBe("Test Tree");
    expect(ctx.description).toContain("This tree tracks decisions");
    // Falls back to domain parsing since no bindings exist
    expect(ctx.repositories).toContain("backend");
    expect(ctx.repositories).toContain("frontend");
  });

  it("uses default description when NODE.md has no body paragraph", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: Empty Body\nowners: [alice]\n---\n\n# Empty Body\n\n## Domains\n",
    );

    const ctx = readTreeContext(tmp.path);
    expect(ctx.title).toBe("Empty Body");
    expect(ctx.description).toContain("shared organizational memory");
  });
});
