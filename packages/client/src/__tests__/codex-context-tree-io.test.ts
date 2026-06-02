import { describe, expect, it } from "vitest";
import { collectCodexFileChangePaths, toolFileRefsFromCodexFileChange } from "../handlers/codex.js";

describe("Codex Context Tree file refs", () => {
  it("collects explicit path fields and object keys from file_change payloads", () => {
    expect(
      collectCodexFileChangePaths([
        { path: "/tree/NODE.md", content: "/tree/not-a-path-from-content.md" },
        { filePath: "relative/NODE.md" },
        { "domains/runtime/NODE.md": { op: "edit" } },
      ]),
    ).toEqual(["/tree/NODE.md", "relative/NODE.md", "domains/runtime/NODE.md"]);
  });

  it("emits file refs with repo evidence only for paths under the Context Tree checkout", () => {
    const refs = toolFileRefsFromCodexFileChange({
      changes: [
        { path: "/home/op/context-tree/NODE.md" },
        { path: "/home/op/context-tree/NODE.md" },
        { path: "/home/op/context-tree-sibling/NODE.md" },
        { path: "../context-tree-sibling/NODE.md" },
        { path: "/home/op/source/NODE.md" },
      ],
      workspaceCwd: "/home/op/source",
      contextTreePath: "/home/op/context-tree",
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    expect(refs).toEqual([
      {
        origin: "file_change",
        localPath: "/home/op/context-tree/NODE.md",
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
      },
      {
        origin: "file_change",
        localPath: "/home/op/context-tree-sibling/NODE.md",
        pathKind: "file",
      },
      {
        origin: "file_change",
        localPath: "/home/op/source/NODE.md",
        pathKind: "file",
      },
    ]);
  });
});
