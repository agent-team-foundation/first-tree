import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const memberMocks = vi.hoisted(() => ({ createMemberSdk: vi.fn() }));
const coreMocks = vi.hoisted(() => ({ preflightContextTreeWrite: vi.fn() }));
const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number, metadata?: { status?: string }) => {
    throw Object.assign(new Error(message), { code, exitCode, metadata });
  }),
  isJsonMode: vi.fn(() => false),
  result: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../commands/_shared/member.js", () => memberMocks);
vi.mock("../core/context-tree-write.js", () => {
  class ContextTreeWritePreflightCliError extends Error {
    readonly stage: string;
    readonly exitCode: number;

    constructor(
      readonly code: string,
      message: string,
      options: { stage: string; exitCode: number },
    ) {
      super(message);
      this.stage = options.stage;
      this.exitCode = options.exitCode;
    }
  }
  return { ContextTreeWritePreflightCliError, preflightContextTreeWrite: coreMocks.preflightContextTreeWrite };
});
vi.mock("../core/output.js", () => ({
  isJsonMode: outputMocks.isJsonMode,
  print: {
    fail: outputMocks.fail,
    result: outputMocks.result,
    status: outputMocks.status,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  outputMocks.isJsonMode.mockReturnValue(false);
});

function commandWith(options: { team?: string; snapshot?: string; githubLogin?: string }): Command {
  return { opts: () => options } as unknown as Command;
}

describe("tree write command action", () => {
  it("passes only explicit invocation inputs into the stateless core", async () => {
    const sdk = { preflightMemberContextTreeWrite: vi.fn() };
    memberMocks.createMemberSdk.mockReturnValue(sdk);
    const preflight = {
      teamId: "team-a",
      binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
      baseCommit: "a".repeat(40),
      snapshotPath: "/tmp/task-snapshot",
      reviewerAgentUuid: "reviewer-current",
      requesterGithubLogin: "writer",
    };
    coreMocks.preflightContextTreeWrite.mockImplementationOnce(async (reader, input) => {
      await reader.preflightMemberContextTreeWrite(
        input.teamId,
        { requesterGithubLogin: input.requesterGithubLogin },
        { retry: false },
      );
      return preflight;
    });
    const { runTreeWriteCommand } = await import("../commands/tree/write.js");

    await runTreeWriteCommand({
      command: commandWith({ team: "team-a", snapshot: "/tmp/task-snapshot", githubLogin: "writer" }),
      options: { debug: false, json: true, quiet: false },
    });

    expect(memberMocks.createMemberSdk).toHaveBeenCalledTimes(1);
    expect(sdk.preflightMemberContextTreeWrite).toHaveBeenCalledWith(
      "team-a",
      { requesterGithubLogin: "writer" },
      { retry: false },
    );
    expect(coreMocks.preflightContextTreeWrite.mock.calls[0]?.[1]).toEqual({
      teamId: "team-a",
      snapshotPath: "/tmp/task-snapshot",
      requesterGithubLogin: "writer",
    });
    expect(outputMocks.result).toHaveBeenCalledWith(preflight);
  });

  it("prints the complete authority tuple for a human invocation", async () => {
    const preflight = {
      teamId: "team-a",
      binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
      baseCommit: "b".repeat(40),
      snapshotPath: "/tmp/task-snapshot",
      reviewerAgentUuid: "reviewer-current",
      requesterGithubLogin: "writer",
    };
    coreMocks.preflightContextTreeWrite.mockResolvedValueOnce(preflight);
    const { runTreeWriteCommand } = await import("../commands/tree/write.js");

    await runTreeWriteCommand({
      command: commandWith({ team: "team-a", snapshot: preflight.snapshotPath, githubLogin: "writer" }),
      options: { debug: false, json: false, quiet: false },
    });

    expect(outputMocks.status.mock.calls).toEqual([
      ["Team", "team-a"],
      ["Binding", "https://github.com/acme/context-tree.git#main"],
      ["Exact base", preflight.baseCommit],
      ["Snapshot", preflight.snapshotPath],
      ["Current Reviewer", "reviewer-current"],
      ["GitHub identity", "writer"],
    ]);
  });

  it("preserves stable preflight failure code and stage", async () => {
    const { ContextTreeWritePreflightCliError } = await import("../core/context-tree-write.js");
    coreMocks.preflightContextTreeWrite.mockRejectedValueOnce(
      new ContextTreeWritePreflightCliError("CONTEXT_TREE_WRITE_SNAPSHOT_STALE", "Snapshot is stale.", {
        stage: "base",
        exitCode: 1,
      }),
    );
    const { runTreeWriteCommand } = await import("../commands/tree/write.js");

    await expect(
      runTreeWriteCommand({
        command: commandWith({ team: "team-a", snapshot: "/tmp/task-snapshot", githubLogin: "writer" }),
        options: { debug: false, json: true, quiet: false },
      }),
    ).rejects.toMatchObject({
      code: "CONTEXT_TREE_WRITE_SNAPSHOT_STALE",
      exitCode: 1,
      metadata: { status: "base" },
    });
  });
});
