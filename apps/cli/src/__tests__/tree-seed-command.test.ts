import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const memberMocks = vi.hoisted(() => ({ createMemberSdk: vi.fn() }));
const coreMocks = vi.hoisted(() => ({ preflightContextTreeSeed: vi.fn() }));
const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number, metadata?: { status?: string }) => {
    throw Object.assign(new Error(message), { code, exitCode, metadata });
  }),
  isJsonMode: vi.fn(() => false),
  result: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../commands/_shared/member.js", () => memberMocks);
vi.mock("../core/context-tree-seed.js", () => {
  class ContextTreeSeedPreflightCliError extends Error {
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
  return { ContextTreeSeedPreflightCliError, preflightContextTreeSeed: coreMocks.preflightContextTreeSeed };
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

function commandWith(options: { team?: string }): Command {
  return { opts: () => options } as unknown as Command;
}

describe("tree seed command action", () => {
  it("passes only the explicit Team into the stateless member core", async () => {
    const sdk = { preflightMemberContextTreeSeed: vi.fn() };
    memberMocks.createMemberSdk.mockReturnValue(sdk);
    const preflight = { teamId: "team-a", state: { status: "unbound", branch: "main" } };
    coreMocks.preflightContextTreeSeed.mockImplementationOnce(async (reader, input) => {
      await reader.preflightMemberContextTreeSeed(input.teamId, {}, { retry: false });
      return preflight;
    });
    const { runTreeSeedCommand } = await import("../commands/tree/seed.js");

    await runTreeSeedCommand({
      command: commandWith({ team: "team-a" }),
      options: { debug: false, json: true, quiet: false },
    });

    expect(sdk.preflightMemberContextTreeSeed).toHaveBeenCalledWith("team-a", {}, { retry: false });
    expect(coreMocks.preflightContextTreeSeed.mock.calls[0]?.[1]).toEqual({ teamId: "team-a" });
    expect(outputMocks.result).toHaveBeenCalledWith(preflight);
  });

  it("prints complete bound and unbound state for human invocations", async () => {
    const { runTreeSeedCommand } = await import("../commands/tree/seed.js");
    coreMocks.preflightContextTreeSeed.mockResolvedValueOnce({
      teamId: "team-a",
      state: {
        status: "bound",
        binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
      },
    });
    await runTreeSeedCommand({
      command: commandWith({ team: "team-a" }),
      options: { debug: false, json: false, quiet: false },
    });
    expect(outputMocks.status.mock.calls).toEqual([
      ["Team", "team-a"],
      ["Seed authority", "Admin"],
      ["Context Tree", "Bound"],
      ["Binding", "https://github.com/acme/context-tree.git#main"],
    ]);

    outputMocks.status.mockClear();
    coreMocks.preflightContextTreeSeed.mockResolvedValueOnce({
      teamId: "team-a",
      state: { status: "unbound", branch: "trunk" },
    });
    await runTreeSeedCommand({
      command: commandWith({ team: "team-a" }),
      options: { debug: false, json: false, quiet: false },
    });
    expect(outputMocks.status.mock.calls).toEqual([
      ["Team", "team-a"],
      ["Seed authority", "Admin"],
      ["Context Tree", "Unbound"],
      ["Branch", "trunk"],
    ]);
  });

  it("preserves Needs Admin code and authority stage", async () => {
    const { ContextTreeSeedPreflightCliError } = await import("../core/context-tree-seed.js");
    coreMocks.preflightContextTreeSeed.mockRejectedValueOnce(
      new ContextTreeSeedPreflightCliError("CONTEXT_TREE_SEED_NEEDS_ADMIN", "Needs Admin.", {
        stage: "authority",
        exitCode: 3,
      }),
    );
    const { runTreeSeedCommand } = await import("../commands/tree/seed.js");

    await expect(
      runTreeSeedCommand({
        command: commandWith({ team: "team-a" }),
        options: { debug: false, json: true, quiet: false },
      }),
    ).rejects.toMatchObject({
      code: "CONTEXT_TREE_SEED_NEEDS_ADMIN",
      exitCode: 3,
      metadata: { status: "authority" },
    });
  });
});
