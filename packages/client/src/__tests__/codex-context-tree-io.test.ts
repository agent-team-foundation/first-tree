import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendGitStatusDeltaRefs,
  collectCodexFileChangePaths,
  toolFileRefsForTerminalCodexTool,
  toolFileRefsFromCodexFileChange,
} from "../handlers/codex.js";
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

  it("appends git status delta refs after ordinary Codex refs", () => {
    const existingRefs = [
      {
        origin: "file_change" as const,
        localPath: "/home/op/context-tree/NODE.md",
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoRelativePath: "NODE.md",
        pathKind: "file" as const,
      },
    ];
    const gitWriteTracker = {
      captureBaseline() {},
      refsForSuccessfulToolCall(input: { existingRefs?: readonly unknown[] }) {
        expect(input.existingRefs).toEqual(existingRefs);
        return [
          {
            origin: "git_status_delta" as const,
            localPath: "/home/op/context-tree/domains/new.md",
            repoUrl: "https://github.com/acme/first-tree-context.git",
            repoRelativePath: "domains/new.md",
            pathKind: "file" as const,
          },
        ];
      },
    };

    expect(
      appendGitStatusDeltaRefs({
        existingRefs,
        gitWriteTracker,
        toolName: "file_change",
        toolUseId: "fc-1",
      }),
    ).toEqual([
      ...existingRefs,
      {
        origin: "git_status_delta",
        localPath: "/home/op/context-tree/domains/new.md",
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoRelativePath: "domains/new.md",
        pathKind: "file",
      },
    ]);
  });

  it("advances git status baseline without refs for failed Codex tools", () => {
    let baselineCaptures = 0;
    const gitWriteTracker = {
      captureBaseline() {
        baselineCaptures += 1;
      },
      refsForSuccessfulToolCall() {
        throw new Error("failed tools must not emit git status refs");
      },
    };

    expect(
      toolFileRefsForTerminalCodexTool({
        status: "error",
        existingRefs: [],
        gitWriteTracker,
        toolName: "command",
        toolUseId: "cmd-failed",
      }),
    ).toBeUndefined();
    expect(baselineCaptures).toBe(1);
  });
});

describe("Codex file refs through the W1 workspace symlink", () => {
  let root: string;
  let realTree: string;
  let link: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "first-tree-codex-symlink-"));
    realTree = join(root, "context-tree-repos", "abc123");
    mkdirSync(realTree, { recursive: true });
    writeFileSync(join(realTree, "NODE.md"), "root");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    link = join(workspace, "context-tree");
    symlinkSync(realTree, link);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("maps file_change paths that travel through the symlink to the real-clone binding", () => {
    const refs = toolFileRefsFromCodexFileChange({
      changes: [{ path: join(link, "NODE.md") }],
      workspaceCwd: join(root, "workspace"),
      contextTreePath: realTree,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    expect(refs).toEqual([
      {
        origin: "file_change",
        localPath: join(link, "NODE.md"),
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
      },
    ]);
  });
});
