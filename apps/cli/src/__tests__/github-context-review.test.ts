import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number) => {
    throw new Error(`${code}:${message}:${exitCode}`);
  }),
  success: vi.fn(),
}));
const sdk = { submitContextReview: vi.fn() };
const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  }),
}));

vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);

const originalChatId = process.env.FIRST_TREE_CHAT_ID;
const originalRuntimeFile = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
let tempDir: string;
let bodyFile: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tempDir = await mkdtemp(join(tmpdir(), "context-review-cli-"));
  bodyFile = join(tempDir, "review.md");
  await writeFile(bodyFile, "## Context approved\n", "utf8");
  const runtimeFile = join(tempDir, "runtime-token");
  await writeFile(runtimeFile, "runtime-proof\n", "utf8");
  process.env.FIRST_TREE_CHAT_ID = "chat-42";
  process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = runtimeFile;
  localAgentMocks.createSdk.mockReturnValue(sdk);
  sdk.submitContextReview.mockResolvedValue({
    action: "APPROVE",
    reviewedHead: "a".repeat(40),
    reviewId: 42,
    reviewUrl: "https://github.com/owner/repo/pull/42#pullrequestreview-42",
    appActor: "first-tree-staging[bot]",
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  setEnv("FIRST_TREE_CHAT_ID", originalChatId);
  setEnv("FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE", originalRuntimeFile);
});

async function run(args: string[]): Promise<void> {
  const { registerGithubContextReviewCommand } = await import("../commands/github/context-review.js");
  const root = new Command();
  const github = root.command("github");
  registerGithubContextReviewCommand(github);
  await root.parseAsync(["node", "test", "github", "context-review", "submit", ...args]);
}

function validArgs(): string[] {
  return [
    "--run",
    "01900000-0000-7000-8000-000000000042",
    "--head",
    "a".repeat(40),
    "--event",
    "APPROVE",
    "--body-file",
    bodyFile,
  ];
}

describe("github context-review submit", () => {
  it("submits only the server-derived chat and narrow review payload", async () => {
    await run([...validArgs(), "--agent", "reviewer"]);
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("reviewer");
    expect(sdk.submitContextReview).toHaveBeenCalledWith("chat-42", "01900000-0000-7000-8000-000000000042", {
      reviewedHead: "a".repeat(40),
      event: "APPROVE",
      body: "## Context approved\n",
    });
    expect(outputMocks.success).toHaveBeenCalledWith(
      expect.objectContaining({ appActor: "first-tree-staging[bot]" }),
    );
  });

  it("fails before SDK creation without chat or runtime-session proof", async () => {
    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(run(validArgs())).rejects.toThrow("NO_CHAT_CONTEXT");
    process.env.FIRST_TREE_CHAT_ID = "chat-42";
    delete process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
    await expect(run(validArgs())).rejects.toThrow("NO_RUNTIME_SESSION");
    process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = join(tempDir, "missing-runtime-token");
    await expect(run(validArgs())).rejects.toThrow("NO_RUNTIME_SESSION");
    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
  });

  it("rejects invalid event, abbreviated head, and empty body", async () => {
    await expect(run(validArgs().map((value) => (value === "APPROVE" ? "MERGE" : value)))).rejects.toThrow(
      "INVALID_CONTEXT_REVIEW",
    );
    await expect(run(validArgs().map((value) => (value === "a".repeat(40) ? "abc123" : value)))).rejects.toThrow(
      "INVALID_CONTEXT_REVIEW",
    );
    await writeFile(bodyFile, "", "utf8");
    await expect(run(validArgs())).rejects.toThrow("INVALID_CONTEXT_REVIEW");
  });

  it("does not expose repo, PR, chat, token, or inline-body options", async () => {
    const { registerGithubContextReviewCommand } = await import("../commands/github/context-review.js");
    const root = new Command();
    const github = root.command("github");
    registerGithubContextReviewCommand(github);
    const contextReview = github.commands.find((command) => command.name() === "context-review");
    const submit = contextReview?.commands.find((command) => command.name() === "submit");
    expect(submit?.options.map((option) => option.long).sort()).toEqual([
      "--agent",
      "--body-file",
      "--event",
      "--head",
      "--run",
    ]);
  });
});

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
