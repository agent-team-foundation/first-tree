import { describe, expect, it } from "vitest";
import { collectCodexFileChangePaths, toolFileRefsFromCodexFileChange } from "../handlers/codex.js";
import { toolFileRefsFromShellCommand } from "../runtime/context-tree-file-refs.js";

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

  it("emits shell read refs for Codex command_execution paths under the Context Tree checkout", () => {
    const refs = toolFileRefsFromShellCommand({
      command: "sed -n '1,240p' /home/op/context-tree/NODE.md",
      cwd: "/home/op/source",
      contextTreePath: "/home/op/context-tree",
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    expect(refs).toEqual([
      {
        origin: "tool_arg",
        localPath: "/home/op/context-tree/NODE.md",
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
      },
    ]);
  });

  // Codex CLI does not surface raw `sed` / `cat` — every command_execution
  // lands as `/bin/<login-shell> -lc '<inner>'` (zsh on macOS, bash on Linux).
  // This is the real wire shape pulled from a session_events row during the
  // fix investigation. Without the shared `classifyShellCommandIo` wrapper
  // unwrap, the outer `zsh` / `bash` falls into MUTATING_OR_AMBIGUOUS_TOOLS
  // and the client never attaches file refs, so the Context tab dashboard
  // records nothing for codex agents. Lock the wrapped form down end-to-end.
  it("emits shell read refs for Codex's /bin/zsh -lc 'sed ...' wrapper (macOS form)", () => {
    const refs = toolFileRefsFromShellCommand({
      command: "/bin/zsh -lc \"sed -n '1,7p' /home/op/context-tree/NODE.md\"",
      cwd: "/home/op/source",
      contextTreePath: "/home/op/context-tree",
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    expect(refs).toEqual([
      {
        origin: "tool_arg",
        localPath: "/home/op/context-tree/NODE.md",
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
      },
    ]);
  });

  it("emits shell read refs for Codex's /bin/bash -lc 'cat ...' wrapper (Linux form)", () => {
    const refs = toolFileRefsFromShellCommand({
      command: "/bin/bash -lc 'cat /home/op/context-tree/NODE.md'",
      cwd: "/home/op/source",
      contextTreePath: "/home/op/context-tree",
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    expect(refs).toEqual([
      {
        origin: "tool_arg",
        localPath: "/home/op/context-tree/NODE.md",
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
      },
    ]);
  });

  it("rejects Codex shell read candidates outside the Context Tree checkout or using write syntax", () => {
    const base = {
      cwd: "/home/op/source",
      contextTreePath: "/home/op/context-tree",
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
    };

    expect(toolFileRefsFromShellCommand({ ...base, command: "cat /home/op/context-tree-sibling/NODE.md" })).toEqual([]);
    expect(toolFileRefsFromShellCommand({ ...base, command: "cat /home/op/context-tree/NODE.md | head" })).toEqual([]);
    expect(toolFileRefsFromShellCommand({ ...base, command: "echo x > /home/op/context-tree/NODE.md" })).toEqual([]);
  });
});
