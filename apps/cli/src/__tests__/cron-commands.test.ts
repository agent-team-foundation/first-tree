import { SdkError } from "@first-tree/client";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number) => {
    throw new Error(`${code}:${message}:${exitCode}`);
  }),
  success: vi.fn(),
}));

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  }),
}));

vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);

function command(parent: Command, name: string): Command {
  const found = parent.commands.find((entry) => entry.name() === name);
  if (!found) throw new Error(`Missing command ${name}`);
  return found;
}

const originalChatId = process.env.FIRST_TREE_CHAT_ID;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FIRST_TREE_CHAT_ID;
});

afterEach(() => {
  if (originalChatId === undefined) delete process.env.FIRST_TREE_CHAT_ID;
  else process.env.FIRST_TREE_CHAT_ID = originalChatId;
});

describe("cron commands", () => {
  it("registers the public cron namespace without --agent targeting", async () => {
    const { registerCronCommands } = await import("../commands/cron/index.js");
    const root = new Command();
    registerCronCommands(root);
    const cron = command(root, "cron");
    expect(cron.commands.map((entry) => entry.name()).sort()).toEqual([
      "create",
      "delete",
      "list",
      "pause",
      "preview",
      "resume",
      "show",
      "update",
    ]);
    for (const name of cron.commands.map((entry) => entry.name())) {
      expect(command(cron, name).options.some((option) => option.long === "--agent")).toBe(false);
    }
  });

  it("fails with CRON_JOB_CHAT_REQUIRED when FIRST_TREE_CHAT_ID is missing", async () => {
    const { registerCronCommands } = await import("../commands/cron/index.js");
    const root = new Command();
    registerCronCommands(root);
    await expect(
      command(command(root, "cron"), "preview").parseAsync(["--schedule", "0 9 * * *", "--timezone", "UTC"], {
        from: "user",
      }),
    ).rejects.toThrow(/CRON_JOB_CHAT_REQUIRED/);
  });

  it("previews through the bound chat and reports success", async () => {
    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    const preview = {
      schedule: "0 9 * * *",
      timezone: "UTC",
      occurrences: [{ at: "2026-07-24T09:00:00.000Z", local: "x", timezone: "UTC" }],
    };
    const sdk = { previewCronJob: vi.fn().mockResolvedValue(preview) };
    localAgentMocks.createSdk.mockReturnValue(sdk);

    const { registerCronCommands } = await import("../commands/cron/index.js");
    const root = new Command();
    registerCronCommands(root);
    await command(command(root, "cron"), "preview").parseAsync(["--schedule", "0 9 * * *", "--timezone", "UTC"], {
      from: "user",
    });
    expect(sdk.previewCronJob).toHaveBeenCalledTimes(1);
    expect(sdk.previewCronJob).toHaveBeenCalledWith("chat-env", { schedule: "0 9 * * *", timezone: "UTC" });
    expect(outputMocks.success).toHaveBeenCalledWith(preview);
  });

  it("maps revision mismatch to a stable CLI code", async () => {
    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    const { SdkError: RealSdkError } = await import("@first-tree/client");
    const sdk = {
      getCronJob: vi.fn().mockResolvedValue({ id: "job-1", revision: 3 }),
      updateCronJob: vi
        .fn()
        .mockRejectedValue(new RealSdkError(409, "revision mismatch", { code: "CRON_JOB_REVISION_MISMATCH" })),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);
    const { registerCronCommands } = await import("../commands/cron/index.js");
    const root = new Command();
    registerCronCommands(root);
    await expect(
      command(command(root, "cron"), "update").parseAsync(["job-1", "--name", "renamed"], { from: "user" }),
    ).rejects.toThrow(/CRON_JOB_REVISION_MISMATCH/);
    expect(sdk.getCronJob).toHaveBeenCalledTimes(1);
    expect(sdk.updateCronJob).toHaveBeenCalledTimes(1);
  });
});
