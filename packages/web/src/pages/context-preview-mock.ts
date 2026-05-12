// TEMPORARY: mock snapshot for /preview/context. Delete with the route.
import type {
  ContextTreeNode,
  ContextTreeSnapshot,
  ContextTreeUpdate,
} from "@agent-team-foundation/first-tree-hub-shared";

const node = (
  id: string,
  parentId: string | null,
  path: string,
  title: string,
  kind: "root" | "domain" | "subdomain" | "leaf",
  changeType: ContextTreeNode["changeType"],
): ContextTreeNode => ({
  id,
  parentId,
  path,
  sourcePath: kind === "leaf" ? `${path}.md` : null,
  title,
  kind,
  owners: [],
  preview: changeType ? `Mock preview content for **${title}**.` : null,
  relatedNodeIds: [] as string[],
  affectedContextArea: title,
  changeType,
  changedAtCommit: changeType ? "83c3939" : null,
});

const update = (
  id: string,
  nodeId: string,
  path: string,
  title: string,
  changeType: ContextTreeUpdate["changeType"],
  changedBy: string,
  area: string,
  owners: string[] = [],
): ContextTreeUpdate => ({
  id,
  nodeId,
  path,
  title,
  changeType,
  affectedContextArea: area,
  reason: "Recent commit",
  summary: `${changedBy} ${changeType} ${title}: clarified scope and refreshed examples.`,
  changedBy,
  owners,
  relatedNodeIds: [],
  sourceCommit: "83c3939e",
  riskLevel: "low",
});

export const MOCK_CONTEXT_SNAPSHOT: ContextTreeSnapshot = {
  repo: "agent-team-foundation/first-tree-context",
  branch: "main",
  headCommit: "83c3939e90b",
  syncedAt: new Date().toISOString(),
  snapshotStatus: "active",
  contextStatus: {
    label: "Context Tree is up to date",
    detail: "Agents have a synced team context snapshot available.",
    severity: "ok",
  },
  summary: { addedCount: 1, editedCount: 4, removedCount: 1, changedNodeCount: 6 },
  nodes: [
    node("root", null, "/", "Context Tree", "root", null),

    // AGENTS: quiet branch with 3 quiet L2 children.
    node("agents", "root", "/agents", "AGENTS", "domain", null),
    node("agents/msg", "agents", "/agents/msg", "Messaging System", "subdomain", null),
    node("agents/prod", "agents", "/agents/prod", "Product Direction", "subdomain", null),
    node("agents/wc", "agents", "/agents/wc", "Web Console — Workspace", "subdomain", null),

    // First Tree Skill CLI: quiet branch with 5 quiet L2 children.
    node("ftskill", "root", "/ftskill", "First Tree Skill CLI", "domain", null),
    node("ftskill/build", "ftskill", "/ftskill/build", "Build And Distribution", "subdomain", null),
    node("ftskill/cred", "ftskill", "/ftskill/cred", "Credential-Free Core Onboarding", "subdomain", null),
    node("ftskill/onb", "ftskill", "/ftskill/onb", "Onboarding", "subdomain", null),
    node("ftskill/repo", "ftskill", "/ftskill/repo", "Repo Architecture", "subdomain", null),
    node("ftskill/src", "ftskill", "/ftskill/src", "Source/Workspace Installation Contract", "subdomain", null),

    // Kael: 1 own edit, 1 hidden quiet child.
    node("kael", "root", "/kael", "Kael", "domain", "edited"),
    node("kael/legacy", "kael", "/kael/legacy", "Legacy CLI Notes", "subdomain", null),

    // Members: 4 updates including selected Notebook.
    node("members", "root", "/members", "Members", "domain", "edited"),
    node("members/yzw", "members", "/members/yzw", "yuezengwu", "subdomain", "edited"),
    node("members/yzw/notebook", "members/yzw", "/members/yzw/notebook", "Notebook", "leaf", "added"),
    node("members/yzw/journal", "members/yzw", "/members/yzw/journal", "Journal", "leaf", null),
    node("members/yzw/scratch", "members/yzw", "/members/yzw/scratch", "Scratch", "leaf", null),
    node("members/bxh", "members", "/members/bxh", "baixiaohang", "subdomain", null),
    node("members/lc", "members", "/members/lc", "liuchao", "subdomain", null),

    // Practices: Tree Maintenance has its own removed change, plus 1 hidden quiet child.
    node("practices", "root", "/practices", "Practices", "domain", "edited"),
    node("practices/tm", "practices", "/practices/tm", "Tree Maintenance", "subdomain", "removed"),
    node("practices/cr", "practices", "/practices/cr", "Code Review", "subdomain", null),
  ],
  edges: [],
  changes: [],
  updates: [
    update(
      "u1",
      "members/yzw/notebook",
      "/members/yzw/notebook",
      "Notebook",
      "added",
      "yuezengwu",
      "members / yuezengwu / notebook",
      ["yuezengwu"],
    ),
    update("u2", "members/yzw", "/members/yzw", "yuezengwu", "edited", "yuezengwu", "members / yuezengwu", [
      "yuezengwu",
    ]),
    update("u3", "members", "/members", "Members", "edited", "yuezengwu", "members", []),
    update("u4", "kael", "/kael", "Kael", "edited", "yuezengwu", "kael", ["liuchao-001", "yuezengwu"]),
    update(
      "u5",
      "practices/tm",
      "/practices/tm",
      "Tree Maintenance Practices",
      "removed",
      "yuezengwu",
      "practices / tree maintenance",
      [],
    ),
    update("u6", "practices", "/practices", "Practices", "edited", "baixiaohang", "practices", [
      "liuchao-001",
      "bingran-you",
    ]),
  ],
};
