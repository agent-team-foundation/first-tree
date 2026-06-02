import { describe, expect, it } from "vitest";
import { collectCodexFileChangePaths, contextTreeWriteCandidatesFromCodexFileChange } from "../handlers/codex.js";

describe("Codex Context Tree IO candidates", () => {
  it("collects explicit path fields and object keys from file_change payloads", () => {
    expect(
      collectCodexFileChangePaths([
        { path: "/tree/NODE.md", content: "/tree/not-a-path-from-content.md" },
        { filePath: "relative/NODE.md" },
        { "domains/runtime/NODE.md": { op: "edit" } },
      ]),
    ).toEqual(["/tree/NODE.md", "relative/NODE.md", "domains/runtime/NODE.md"]);
  });

  it("emits write candidates only for paths under the Context Tree checkout", () => {
    const candidates = contextTreeWriteCandidatesFromCodexFileChange({
      changes: [
        { path: "/home/op/context-tree/NODE.md" },
        { path: "/home/op/context-tree/NODE.md" },
        { path: "/home/op/context-tree-sibling/NODE.md" },
        { path: "../context-tree-sibling/NODE.md" },
        { path: "/home/op/source/NODE.md" },
      ],
      workspaceCwd: "/home/op/source",
      toolUseId: "fc-1",
      contextTreePath: "/home/op/context-tree",
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    expect(candidates).toEqual([
      {
        action: "write",
        source: "codex_file_change",
        treeRepoUrl: "https://github.com/acme/first-tree-context.git",
        treeBranch: "main",
        targetKind: "file",
        targetPath: "NODE.md",
        metadata: {
          toolUseId: "fc-1",
          localPath: "/home/op/context-tree/NODE.md",
        },
      },
    ]);
  });
});
