import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectContributorMembers,
  parseGitHubRemoteUrl,
  parseGitShortlog,
  seedMembersFromContributors,
} from "#products/tree/engine/member-seeding.js";
import { useTmpDir } from "../helpers.js";

function writeInstalledTemplates(root: string): void {
  const templatesDir = join(
    root,
    ".agents",
    "skills",
    "first-tree",
    "assets",
    "framework",
    "templates",
  );
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(
    join(templatesDir, "members-domain.md.template"),
    "---\ntitle: Members\nowners: []\n---\n# Members\n",
  );
  writeFileSync(
    join(templatesDir, "member-node.md.template"),
    [
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
    ].join("\n"),
  );
}

describe("parseGitHubRemoteUrl", () => {
  it("parses https remotes", () => {
    expect(parseGitHubRemoteUrl("https://github.com/acme/context-tree.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "context-tree",
    });
  });

  it("parses ssh remotes", () => {
    expect(parseGitHubRemoteUrl("git@github.com:acme/context-tree.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "context-tree",
    });
  });
});

describe("parseGitShortlog", () => {
  it("dedupes contributors and classifies obvious bots", () => {
    const contributors = parseGitShortlog(
      [
        "   12\tAlice Example <alice@example.com>",
        "    4\tRenovate Bot <renovate[bot]@users.noreply.github.com>",
        "    3\tAlice Example <alice@example.com>",
      ].join("\n"),
    );

    expect(contributors).toEqual([
      {
        contributions: 15,
        owner: "alice",
        role: "Contributor",
        slug: "alice",
        source: "git",
        title: "Alice Example",
        type: "human",
      },
      {
        contributions: 4,
        owner: "renovate-bot",
        role: "Automation Contributor",
        slug: "renovate-bot",
        source: "git",
        title: "Renovate Bot",
        type: "autonomous_agent",
      },
    ]);
  });
});

describe("collectContributorMembers", () => {
  it("prefers GitHub contributors when gh returns data", () => {
    const result = collectContributorMembers(
      "/tmp/repo",
      (command, args) => {
        if (command === "git" && args.join(" ") === "remote get-url origin") {
          return "https://github.com/acme/context-tree.git";
        }
        if (command === "gh") {
          return JSON.stringify([
            [
              {
                contributions: 9,
                login: "alice",
                type: "User",
              },
            ],
          ]);
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    );

    expect(result).toEqual({
      contributors: [
        {
          contributions: 9,
          owner: "alice",
          role: "Contributor",
          slug: "alice",
          source: "github",
          title: "alice",
          type: "human",
        },
      ],
      source: "github",
    });
  });

  it("falls back to local git history when gh is unavailable", () => {
    const result = collectContributorMembers(
      "/tmp/repo",
      (command, args) => {
        if (command === "git" && args.join(" ") === "remote get-url origin") {
          return "https://github.com/acme/context-tree.git";
        }
        if (command === "gh") {
          throw new Error("gh unavailable");
        }
        if (command === "git" && args.join(" ") === "shortlog -se --all --no-merges") {
          return "   3\tAlice Example <alice@example.com>";
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    );

    expect(result.notice).toContain("GitHub contributor lookup was unavailable");
    expect(result.source).toBe("git");
    expect(result.contributors).toHaveLength(1);
    expect(result.contributors[0]?.slug).toBe("alice");
  });
});

describe("seedMembersFromContributors", () => {
  it("creates member nodes and backfills members/NODE.md when needed", () => {
    const sourceRepo = useTmpDir();
    const treeRepo = useTmpDir();
    writeInstalledTemplates(treeRepo.path);

    const result = seedMembersFromContributors(
      sourceRepo.path,
      treeRepo.path,
      () => ({
        contributors: [
          {
            owner: "alice",
            role: "Contributor",
            slug: "alice",
            source: "github",
            title: "Alice Example",
            type: "human",
          },
          {
            owner: "renovate-bot",
            role: "Automation Contributor",
            slug: "renovate-bot",
            source: "git",
            title: "Renovate Bot",
            type: "autonomous_agent",
          },
        ],
        source: "github",
      }),
    );

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(readFileSync(join(treeRepo.path, "members", "NODE.md"), "utf-8")).toContain(
      "# Members",
    );
    expect(
      readFileSync(join(treeRepo.path, "members", "alice", "NODE.md"), "utf-8"),
    ).toContain('domains:\n  - "unassigned"');
    expect(
      readFileSync(join(treeRepo.path, "members", "renovate-bot", "NODE.md"), "utf-8"),
    ).toContain('type: "autonomous_agent"');
  });

  it("skips contributors whose member directories already exist", () => {
    const treeRepo = useTmpDir();
    writeInstalledTemplates(treeRepo.path);
    mkdirSync(join(treeRepo.path, "members", "alice"), { recursive: true });
    writeFileSync(
      join(treeRepo.path, "members", "alice", "NODE.md"),
      "---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Engineer\ndomains:\n  - engineering\n---\n",
    );

    const result = seedMembersFromContributors(
      treeRepo.path,
      treeRepo.path,
      () => ({
        contributors: [
          {
            owner: "alice",
            role: "Contributor",
            slug: "alice",
            source: "github",
            title: "Alice Example",
            type: "human",
          },
        ],
        source: "github",
      }),
    );

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
