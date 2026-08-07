import { describe, expect, it } from "vitest";
import {
  CONTEXT_DECISION_METADATA_KEY,
  type ContextDecision,
  contextDecisionSchema,
  readContextDecisionMetadata,
} from "../schemas/context-decision.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SHA256_COMMIT = "0123456789abcdef".repeat(4);

function receipt(overrides: Partial<ContextDecision> = {}): Record<string, unknown> {
  return {
    version: 1,
    effect: "constrained",
    summary: "The organization-isolation constraint ruled out a global shared index.",
    evidence: [
      {
        repoUrl: "https://github.com/example/context-tree",
        commit: COMMIT,
        nodePath: "system/cloud/team/tenancy-and-identity.md",
        heading: "Organization isolation",
      },
    ],
    ...overrides,
  };
}

describe("contextDecisionSchema", () => {
  it("accepts the skill's documented receipt shape", () => {
    const parsed = contextDecisionSchema.safeParse(receipt());
    expect(parsed.success).toBe(true);
  });

  it("accepts an omitted heading and up to three evidence rows", () => {
    const rows = [
      { repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "a.md" },
      { repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "b/c.md" },
      { repoUrl: "git@gitlab.example.com:group/sub/tree.git", commit: SHA256_COMMIT, nodePath: "d.md" },
    ];
    expect(contextDecisionSchema.safeParse(receipt({ evidence: rows })).success).toBe(true);
  });

  // The producer copies the declared binding repository verbatim, so every
  // transport the binding accepts must survive the receipt too — an SSH-backed
  // team otherwise cannot send a valid final message at all.
  it("accepts every credential-free binding transport the Context Tree binding allows", () => {
    const transports = [
      "https://github.com/example/context-tree",
      "https://github.com/example/context-tree.git",
      "ssh://git@github.com/example/context-tree.git",
      "git@github.com:example/context-tree.git",
      "ssh://git@gitlab.example.com:2222/group/sub/context-tree.git",
    ];
    for (const repoUrl of transports) {
      const parsed = contextDecisionSchema.safeParse(
        receipt({ evidence: [{ repoUrl, commit: COMMIT, nodePath: "a.md" }] }),
      );
      expect(parsed.success, repoUrl).toBe(true);
    }
  });

  it("rejects an effect outside the four observable categories", () => {
    expect(contextDecisionSchema.safeParse(receipt({ effect: "none" as never })).success).toBe(false);
  });

  it("rejects a receipt with nothing to inspect", () => {
    expect(contextDecisionSchema.safeParse(receipt({ evidence: [] })).success).toBe(false);
  });

  it("rejects more evidence than the skill's three-node cap", () => {
    const row = { repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "a.md" };
    expect(contextDecisionSchema.safeParse(receipt({ evidence: [row, row, row, row] })).success).toBe(false);
  });

  it("rejects an empty summary", () => {
    expect(contextDecisionSchema.safeParse(receipt({ summary: "   " })).success).toBe(false);
  });

  // A secret rides a repository URL as userinfo, a query parameter, or a
  // fragment. All three would be persisted verbatim in an immutable row.
  it("rejects every credential-bearing repository URL form", () => {
    const leaky = [
      "https://user:token@github.com/example/tree",
      "https://token@github.com/example/tree",
      "https://github.com/example/tree?access_token=secret",
      "https://github.com/example/tree#access_token=secret",
      "ssh://git:token@github.com/example/tree.git",
    ];
    for (const repoUrl of leaky) {
      const parsed = contextDecisionSchema.safeParse(
        receipt({ evidence: [{ repoUrl, commit: COMMIT, nodePath: "a.md" }] }),
      );
      expect(parsed.success, repoUrl).toBe(false);
    }
  });

  it("rejects transports the Context Tree binding refuses", () => {
    const rejected = ["http://github.com/example/tree", "git://github.com/example/tree", "file:///tmp/tree"];
    for (const repoUrl of rejected) {
      const parsed = contextDecisionSchema.safeParse(
        receipt({ evidence: [{ repoUrl, commit: COMMIT, nodePath: "a.md" }] }),
      );
      expect(parsed.success, repoUrl).toBe(false);
    }
  });

  it("rejects a repository value that is not a resolvable git URL", () => {
    const evidence = [{ repoUrl: "context-tree", commit: COMMIT, nodePath: "a.md" }];
    expect(contextDecisionSchema.safeParse(receipt({ evidence })).success).toBe(false);
  });

  // An abbreviation resolves against one repository at one moment; only a full
  // object id keeps naming the same version for the life of the stored receipt.
  it("requires a full object id and rejects abbreviations", () => {
    expect(
      contextDecisionSchema.safeParse(
        receipt({
          evidence: [{ repoUrl: "https://github.com/example/tree", commit: SHA256_COMMIT, nodePath: "a.md" }],
        }),
      ).success,
    ).toBe(true);
    for (const commit of ["main", "abc1234", COMMIT.slice(0, 12), COMMIT.slice(0, 39), `${COMMIT}ab`]) {
      const evidence = [{ repoUrl: "https://github.com/example/tree", commit, nodePath: "a.md" }];
      expect(contextDecisionSchema.safeParse(receipt({ evidence })).success, commit).toBe(false);
    }
  });

  it("rejects an escaping node path", () => {
    const absolute = [{ repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "/etc/passwd" }];
    const traversal = [{ repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "a/../../b.md" }];
    expect(contextDecisionSchema.safeParse(receipt({ evidence: absolute })).success).toBe(false);
    expect(contextDecisionSchema.safeParse(receipt({ evidence: traversal })).success).toBe(false);
  });
});

describe("readContextDecisionMetadata", () => {
  it("returns the receipt when the stored payload parses", () => {
    expect(readContextDecisionMetadata({ [CONTEXT_DECISION_METADATA_KEY]: receipt() })?.effect).toBe("constrained");
  });

  it("fails closed on absent, unknown-version, and malformed payloads", () => {
    expect(readContextDecisionMetadata(undefined)).toBeNull();
    expect(readContextDecisionMetadata(null)).toBeNull();
    expect(readContextDecisionMetadata({})).toBeNull();
    expect(
      readContextDecisionMetadata({ [CONTEXT_DECISION_METADATA_KEY]: receipt({ version: 2 as never }) }),
    ).toBeNull();
    expect(readContextDecisionMetadata({ [CONTEXT_DECISION_METADATA_KEY]: "constrained" })).toBeNull();
    expect(readContextDecisionMetadata({ [CONTEXT_DECISION_METADATA_KEY]: { effect: "constrained" } })).toBeNull();
  });
});
