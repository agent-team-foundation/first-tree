import type { ContextTreeNode } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { buildOverviewNodes, layoutTree } from "../context.js";

const node = (
  id: string,
  parentId: string | null,
  path: string,
  title: string,
  changeType: ContextTreeNode["changeType"] = null,
): ContextTreeNode => ({
  id,
  parentId,
  path,
  sourcePath: null,
  title,
  kind: parentId === null ? "root" : "domain",
  owners: [],
  preview: null,
  relatedNodeIds: [],
  affectedContextArea: title,
  changeType,
  changedAtCommit: changeType ? "commit" : null,
});

const nodes: ContextTreeNode[] = [
  node("root", null, "/", "Context Tree"),
  node("agents", "root", "/agents", "Agents"),
  node("agents/runtime", "agents", "/agents/runtime", "Runtime"),
  node("members", "root", "/members", "Members"),
  node("members/yzw", "members", "/members/yzw", "Yuezengwu"),
  node("members/yzw/notebook", "members/yzw", "/members/yzw/notebook", "Notebook", "added"),
  node("members/yzw/journal", "members/yzw", "/members/yzw/journal", "Journal"),
];

function realNodeIds(overviewNodes: ReturnType<typeof buildOverviewNodes>): string[] {
  return overviewNodes.filter((overviewNode) => !overviewNode.isSummary).map((overviewNode) => overviewNode.id);
}

describe("buildOverviewNodes", () => {
  it("auto-promotes singleton hidden children alongside the top-level areas", () => {
    // `agents` (only child: agents/runtime) and `members` (only child:
    // members/yzw) each have a single hidden child. Folding one row behind
    // a "Show 1 more" toggle is wasted UI — promote it directly. The
    // promotion is transitive: once members/yzw is surfaced it's checked
    // again, but it has two children (notebook + journal), so the chain
    // stops there.
    expect(realNodeIds(buildOverviewNodes(nodes, null, new Map(), new Set()))).toEqual([
      "root",
      "agents",
      "agents/runtime",
      "members",
      "members/yzw",
    ]);
  });

  it("brings selected leaf ancestors back into the visible set", () => {
    // members/yzw is on the selected path so notebook is already visible;
    // its sibling journal is the only remaining hidden child — promoted by
    // the singleton rule. agents/runtime is likewise promoted as agents'
    // only hidden child.
    expect(realNodeIds(buildOverviewNodes(nodes, "members/yzw/notebook", new Map(), new Set()))).toEqual([
      "root",
      "agents",
      "agents/runtime",
      "members",
      "members/yzw",
      "members/yzw/journal",
      "members/yzw/notebook",
    ]);
  });

  it("keeps the hidden-branch summary toggle after expanding a 2+ child parent", () => {
    // members/yzw has two hidden children (notebook + journal). That's a
    // real fold (≥ 2), not a singleton, so expanding it should leave a
    // "Show less" toggle in place so the user can collapse it again.
    const overviewNodes = buildOverviewNodes(nodes, null, new Map(), new Set(["members/yzw"]));
    const yzwSummary = overviewNodes.find((overviewNode) => overviewNode.id === "summary:members/yzw");

    expect(realNodeIds(overviewNodes)).toEqual([
      "root",
      "agents",
      "agents/runtime",
      "members",
      "members/yzw",
      "members/yzw/journal",
      "members/yzw/notebook",
    ]);
    expect(yzwSummary).toMatchObject({
      isSummary: true,
      isExpanded: true,
      parentId: "members/yzw",
      title: "Show less",
    });
  });

  it("builds summary labels for changed hidden nodes and lays out parent links", () => {
    const summaryNodes = [
      ...nodes,
      node("members/yzw/notebook/deep-a", "members/yzw/notebook", "/members/yzw/notebook/deep-a", "Deep A", "added"),
      node("members/yzw/notebook/deep-b", "members/yzw/notebook", "/members/yzw/notebook/deep-b", "Deep B", "edited"),
    ];
    const counts = new Map<string, number>([
      ["members/yzw/notebook/deep-a", 2],
      ["members/yzw/notebook/deep-b", 1],
    ]);
    const overviewNodes = buildOverviewNodes(summaryNodes, null, counts, new Set(["members/yzw"]));
    const summary = overviewNodes.find((overviewNode) => overviewNode.id === "summary:members/yzw/notebook");

    expect(summary).toMatchObject({
      title: "Show 2 more · 2 changed",
      updateCount: 2,
      muted: false,
    });

    const laidOut = layoutTree(summaryNodes, "members/yzw/notebook", counts, new Set(["members/yzw"]));
    expect(laidOut.length).toBeGreaterThan(0);
    expect(laidOut[0]).toMatchObject({ parent: null });
    expect(laidOut.find((layoutNode) => layoutNode.id === "members/yzw")?.parent?.id).toBe("members");
    expect(laidOut.find((layoutNode) => layoutNode.id === "members/yzw/notebook")).toMatchObject({
      selected: true,
      selectedPath: true,
    });
  });

  it("ignores orphan nodes and returns an empty layout for an empty tree", () => {
    expect(layoutTree([], null, new Map(), new Set())).toEqual([]);
    const overviewNodes = buildOverviewNodes(
      [node("orphan", "missing", "/orphan", "Orphan"), node("root", null, "/", "Context Tree")],
      null,
      new Map(),
      new Set(["missing"]),
    );

    expect(overviewNodes.map((overviewNode) => overviewNode.id)).toEqual(["root"]);
  });
});
