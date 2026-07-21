import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTreeCommands } from "../commands/tree/index.js";

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number) => {
    throw new Error(`${code}:${message}:${exitCode}`);
  }),
  success: vi.fn(),
}));
const sdk = { inspectContextReviewAuthority: vi.fn(), submitContextReview: vi.fn() };
const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  }),
}));

vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);

const originalChatId = process.env.FIRST_TREE_CHAT_ID;
const originalAgentId = process.env.FIRST_TREE_AGENT_ID;
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
  process.env.FIRST_TREE_AGENT_ID = "reviewer-agent-42";
  process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = runtimeFile;
  localAgentMocks.createSdk.mockReturnValue(sdk);
  sdk.submitContextReview.mockResolvedValue({
    action: "APPROVE",
    reviewedHead: "a".repeat(40),
    reviewId: 42,
    reviewUrl: "https://github.com/owner/repo/pull/42#pullrequestreview-42",
    appActor: "first-tree-staging[bot]",
    publicationDisposition: "created",
  });
  sdk.inspectContextReviewAuthority.mockResolvedValue({
    authorized: true,
    reviewedHead: "a".repeat(40),
    installationId: 42,
    reviewerClientId: "client-42",
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  setEnv("FIRST_TREE_CHAT_ID", originalChatId);
  setEnv("FIRST_TREE_AGENT_ID", originalAgentId);
  setEnv("FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE", originalRuntimeFile);
});

async function run(args: string[]): Promise<void> {
  const root = new Command();
  registerTreeCommands(root);
  await root.parseAsync(["node", "test", "tree", "review", ...args]);
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

describe("tree review", () => {
  it("submits only the server-derived chat and narrow review payload", async () => {
    await run(validArgs());
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith();
    expect(sdk.submitContextReview).toHaveBeenCalledWith("chat-42", "01900000-0000-7000-8000-000000000042", {
      reviewedHead: "a".repeat(40),
      event: "APPROVE",
      body: "## Context approved\n",
    });
    expect(outputMocks.success).toHaveBeenCalledWith(expect.objectContaining({ appActor: "first-tree-staging[bot]" }));
  });

  it.each(["APPROVE", "REQUEST_CHANGES", "COMMENT"])("accepts the %s event", async (event) => {
    await run(validArgs().map((value) => (value === "APPROVE" ? event : value)));
    expect(sdk.submitContextReview).toHaveBeenCalledWith(
      "chat-42",
      expect.any(String),
      expect.objectContaining({ event }),
    );
  });

  it("runs the strict read-only authority preflight without publishing", async () => {
    await run(["--run", "01900000-0000-7000-8000-000000000042", "--head", "a".repeat(40), "--check"]);
    expect(sdk.inspectContextReviewAuthority).toHaveBeenCalledWith("chat-42", "01900000-0000-7000-8000-000000000042", {
      reviewedHead: "a".repeat(40),
    });
    expect(sdk.submitContextReview).not.toHaveBeenCalled();
    expect(outputMocks.success).toHaveBeenCalledWith(expect.objectContaining({ authorized: true }));
  });

  it("rejects mixed or incomplete check/publication modes", async () => {
    await expect(run([...validArgs(), "--check"])).rejects.toThrow("INVALID_CONTEXT_REVIEW");
    await expect(run(["--run", "run-42", "--head", "a".repeat(40), "--event", "COMMENT"])).rejects.toThrow(
      "INVALID_CONTEXT_REVIEW",
    );
  });

  it("fails before SDK creation without chat or runtime-session proof", async () => {
    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(run(validArgs())).rejects.toThrow("NO_CHAT_CONTEXT");
    process.env.FIRST_TREE_CHAT_ID = "chat-42";
    delete process.env.FIRST_TREE_AGENT_ID;
    await expect(run(validArgs())).rejects.toThrow("NO_AGENT_CONTEXT");
    process.env.FIRST_TREE_AGENT_ID = "reviewer-agent-42";
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

  it("reads the review body from stdin and rejects oversized files", async () => {
    const stdin = new PassThrough();
    Object.defineProperty(stdin, "isTTY", { value: false });
    const stdinSpy = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    try {
      const pending = run(validArgs().map((value) => (value === bodyFile ? "-" : value)));
      stdin.end("Review from stdin\n");
      await pending;
    } finally {
      stdinSpy.mockRestore();
    }
    expect(sdk.submitContextReview).toHaveBeenLastCalledWith(
      "chat-42",
      expect.any(String),
      expect.objectContaining({ body: "Review from stdin\n" }),
    );

    await writeFile(bodyFile, Buffer.alloc(64 * 1024 + 1, "x"));
    await expect(run(validArgs())).rejects.toThrow("REVIEW_BODY_TOO_LARGE");
  });

  it("propagates SDK publication errors through the shared handler", async () => {
    sdk.submitContextReview.mockRejectedValueOnce(new Error("publisher unavailable"));
    await expect(run(validArgs())).rejects.toThrow("publisher unavailable");
    expect(localAgentMocks.handleSdkError).toHaveBeenCalled();
  });

  it("exposes one direct review command without a submit layer", async () => {
    const root = new Command();
    registerTreeCommands(root);
    const tree = root.commands.find((command) => command.name() === "tree");
    const review = tree?.commands.find((command) => command.name() === "review");
    expect(review?.commands).toHaveLength(0);
    expect(review?.options.map((option) => option.long).sort()).toEqual([
      "--body-file",
      "--check",
      "--event",
      "--head",
      "--run",
    ]);
  });

  it("does not expose the removed GitHub review command", async () => {
    const { registerGithubCommands } = await import("../commands/github/index.js");
    const root = new Command();
    registerGithubCommands(root);
    const github = root.commands.find((command) => command.name() === "github");
    expect(github?.commands.map((command) => command.name())).not.toContain("context-review");
  });
});

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
