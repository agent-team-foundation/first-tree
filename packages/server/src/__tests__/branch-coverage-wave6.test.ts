import { describe, expect, it } from "vitest";
import { contextTreeSnapshotTestInternals as internals } from "../services/context-tree-snapshot.js";

describe("branch coverage wave6 — context-tree snapshot internals", () => {
  it("covers parseMarkdownFallback empty values and title lines", () => {
    // frontmatter present with key: value (empty value side of field[2] ?? "")
    const parsed = internals.parseMarkdownFallback(`---
title: 
owners: [a, b]
soft_links: [x]
unknown: 1
not a field
---
body text`);
    const data = parsed.data as Record<string, unknown>;
    expect(data.title).toBe("");
    expect(data.owners).toEqual(["a", "b"]);
    expect(parsed.content).toContain("body text");

    // no frontmatter
    expect(internals.parseMarkdownFallback("just body").data).toEqual({});
  });

  it("covers buildWriteEvents with and without nodeId lookup", () => {
    const tree = internals.buildTreeFromRawFiles([
      {
        relativePath: "domains/runtime/NODE.md",
        raw: "---\ntitle: Runtime\n---\n# Runtime\n",
      },
    ]);
    const node = tree.nodes.find((n) => n.path.includes("runtime"));
    expect(node).toBeDefined();

    const events = internals.buildWriteEvents(
      [
        {
          path: "domains/runtime/NODE.md",
          nodeId: node?.id ?? null,
          type: "edited",
          summary: "long enough summary text here",
          changedBy: "bot",
          changedAt: "2026-01-01T00:00:00.000Z",
          commit: "a".repeat(40),
          prNumber: 1,
        },
        {
          path: "domains/missing/NODE.md",
          nodeId: null,
          type: "added",
          summary: null,
          changedBy: null,
          changedAt: null,
          commit: null,
          prNumber: null,
        },
        {
          path: "domains/ghost/NODE.md",
          nodeId: "missing-id",
          type: "removed",
          summary: "removed node",
          changedBy: "bot",
          changedAt: "2026-01-02T00:00:00.000Z",
          commit: "b".repeat(40),
          prNumber: null,
        },
      ],
      tree.nodes,
    );

    expect(events.length).toBe(3);
    expect(events.some((e) => e.nodeId === null)).toBe(true);
    expect(events.some((e) => e.nodeId === "missing-id")).toBe(true);
  });

  it("covers cleanCommitSubject length guards and PR parse", () => {
    expect(internals.cleanCommitSubject(null)).toBeNull();
    expect(internals.cleanCommitSubject("short")).toBeNull();
    expect(internals.cleanCommitSubject("feat: short")).toBeNull();
    expect(internals.cleanCommitSubject("feat: a sufficiently long subject for display")).toContain(
      "sufficiently long",
    );
    expect(internals.cleanCommitSubject(`feat: ${"x".repeat(200)}`)?.endsWith("...")).toBe(true);

    expect(internals.parsePrNumber(null)).toBeNull();
    expect(internals.parsePrNumber("no pr here")).toBeNull();
    expect(internals.parsePrNumber("Merge pull request #42 from acme/x")).toBe(42);
    expect(internals.parsePrNumber("feat: something (#99)")).toBe(99);
  });

  it("covers dirNodeId and toPosix helpers", () => {
    expect(internals.dirNodeId("")).toBe("root");
    expect(internals.dirNodeId("domains/runtime")).toBe("dir:domains/runtime");
    // toPosix is identity on posix hosts
    expect(internals.toPosix("a/b/c")).toBe("a/b/c");
  });

  it("covers tree build with parent-less and soft-link edges", () => {
    const tree = internals.buildTreeFromRawFiles([
      { relativePath: "NODE.md", raw: "---\ntitle: Root\n---\n# Root\nSee [child](domains/child/NODE.md)\n" },
      {
        relativePath: "domains/child/NODE.md",
        raw: "---\ntitle: Child\nsoft_links: [../other/NODE.md]\n---\n# Child\n",
      },
      {
        relativePath: "domains/other/NODE.md",
        raw: "---\ntitle: Other\n---\n# Other\n",
      },
      // orphan path without parent NODE
      {
        relativePath: "orphan/deep/NODE.md",
        raw: "---\ntitle: Orphan\n---\n# Orphan\n",
      },
    ]);
    expect(tree.nodes.length).toBeGreaterThan(3);
    expect(tree.edges.some((e) => e.kind === "parent")).toBe(true);
  });
});
