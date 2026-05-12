import type { ContextTreeNode } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it } from "vitest";
import { buildOverviewNodes } from "../context.js";

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
  it("shows only root and top-level areas when there are no changed counts or selected path", () => {
    expect(realNodeIds(buildOverviewNodes(nodes, null, new Map(), new Set()))).toEqual(["root", "agents", "members"]);
  });

  it("brings selected leaf ancestors back into the visible set", () => {
    expect(realNodeIds(buildOverviewNodes(nodes, "members/yzw/notebook", new Map(), new Set()))).toEqual([
      "root",
      "agents",
      "members",
      "members/yzw",
      "members/yzw/notebook",
    ]);
  });

  it("keeps the quiet-area summary toggle after expanding a parent", () => {
    const overviewNodes = buildOverviewNodes(nodes, null, new Map(), new Set(["members"]));
    const membersSummary = overviewNodes.find((overviewNode) => overviewNode.id === "summary:members");

    expect(realNodeIds(overviewNodes)).toEqual(["root", "agents", "members", "members/yzw"]);
    expect(membersSummary).toMatchObject({
      isSummary: true,
      isExpanded: true,
      parentId: "members",
      title: "Hide 1 quiet area",
    });
  });
});
