import { SdkError } from "@first-tree/client";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fileMocks = vi.hoisted(() => ({ readFile: vi.fn() }));
const ioMocks = vi.hoisted(() => ({ readStdin: vi.fn() }));
const memberMocks = vi.hoisted(() => ({ createMemberSdk: vi.fn() }));
const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error;
  }),
}));
const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));
const docMocks = vi.hoisted(() => ({ captureOutboundDocs: vi.fn() }));

vi.mock("node:fs/promises", () => fileMocks);
vi.mock("../commands/chat/_shared/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/chat/_shared/io.js")>()),
  readStdin: ioMocks.readStdin,
}));
vi.mock("../commands/_shared/member.js", () => memberMocks);
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/doc-capture.js", () => docMocks);

function metadataJson(): string {
  return JSON.stringify({
    taskType: "context_tree_pr_review",
    reviewPacketV1: {
      schemaVersion: 1,
      repository: "owner/context-tree",
      pullRequest: 749,
      expectedHead: "a".repeat(40),
      baseRef: "main",
      sourceRef: "agent-review-contract",
      requesterGithubLogin: "writer",
      goal: "Record the approved Agent Review contract.",
      source: { label: "Architecture discussion", reference: "first-tree-chat:agent-review-contract" },
      decisionSummary: "Use the existing member task Chat.",
      rationale: "This preserves the normal Chat and Inbox boundary.",
      targetPaths: ["system/context-tree-pr-reviewer.md"],
      repairScope: ["system/context-tree-pr-reviewer.md"],
      relevantContextRefs: [],
      unresolvedQuestions: [],
      verify: { status: "passed", summary: "first-tree tree verify passed" },
      evidence: [],
    },
  });
}

async function runCreate(args: string[]): Promise<void> {
  const { registerChatCreateCommand } = await import("../commands/chat/create.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerChatCreateCommand(program);
  await program.parseAsync(["node", "test", ...args]);
}

describe("chat create --as-member Agent Review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ioMocks.readStdin.mockResolvedValue("Please review this Context Tree PR.\n");
    fileMocks.readFile.mockResolvedValue(metadataJson());
    memberMocks.createMemberSdk.mockReturnValue({
      getMemberProfile: vi.fn(async () => ({
        memberships: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
        defaultOrganizationId: "org-b",
      })),
      createMemberKeyedTaskChat: vi.fn(async () => ({
        chatId: "chat-review",
        messageId: "msg-review",
        topic: "Agent Review: owner/context-tree#749",
        effectiveSenderId: "human-writer",
        reviewerAgentUuid: "private-reviewer",
        outcome: "created",
        managedReviewReceiptV1: {
          schemaVersion: 1,
          repository: "owner/context-tree",
          pullRequest: 749,
          expectedHead: "a".repeat(40),
        },
      })),
    });
  });

  it("uses only the member login, opening file metadata, and server-derived routing", async () => {
    const sdk = memberMocks.createMemberSdk();

    await runCreate(["create", "--as-member", "--format", "markdown", "--metadata-file", "packet.json"]);

    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
    expect(docMocks.captureOutboundDocs).not.toHaveBeenCalled();
    expect(fileMocks.readFile).toHaveBeenCalledWith("packet.json", "utf8");
    expect(sdk.createMemberKeyedTaskChat).toHaveBeenCalledWith("org-b", {
      mode: "keyed_task",
      initialMessage: {
        format: "markdown",
        content: "Please review this Context Tree PR.\n",
        metadata: expect.objectContaining({
          taskType: "context_tree_pr_review",
          reviewPacketV1: expect.objectContaining({ pullRequest: 749 }),
        }),
      },
    });
    const request = sdk.createMemberKeyedTaskChat.mock.calls[0]?.[1];
    expect(JSON.stringify(request)).not.toMatch(/taskKey|reviewerAgentUuid|topic|sender|provenance/);
    expect(outputMocks.success).toHaveBeenCalledWith(expect.objectContaining({ outcome: "created" }));
  });

  it("rejects generic Chat routing and incomplete packet options", async () => {
    await expect(
      runCreate([
        "create",
        "opening",
        "--as-member",
        "--format",
        "markdown",
        "--metadata-file",
        "packet.json",
        "--to",
        "reviewer",
      ]),
    ).rejects.toMatchObject({ code: "KEYED_TASK_OPTIONS", exitCode: 2 });
    await expect(
      runCreate(["create", "opening", "--as-member", "--metadata-file", "packet.json"]),
    ).rejects.toMatchObject({ code: "KEYED_TASK_FORMAT", exitCode: 2 });
    await expect(runCreate(["create", "opening", "--as-member", "--format", "markdown"])).rejects.toMatchObject({
      code: "MISSING_METADATA_FILE",
      exitCode: 2,
    });

    fileMocks.readFile.mockResolvedValueOnce("{bad");
    await expect(
      runCreate(["create", "opening", "--as-member", "--format", "markdown", "--metadata-file", "bad.json"]),
    ).rejects.toMatchObject({ code: "INVALID_METADATA_FILE", exitCode: 2 });
  });

  it("surfaces terminal keyed errors without the ordinary non-idempotent unknown-result warning", async () => {
    const sdk = memberMocks.createMemberSdk();
    const error = new SdkError(503, "temporarily unavailable");
    sdk.createMemberKeyedTaskChat.mockRejectedValueOnce(error);

    await expect(
      runCreate(["create", "opening", "--as-member", "--format", "markdown", "--metadata-file", "packet.json"]),
    ).rejects.toBe(error);
    expect(localAgentMocks.handleSdkError).toHaveBeenCalledWith(error);
    expect(outputMocks.fail).not.toHaveBeenCalledWith("CREATE_RESULT_UNKNOWN", expect.anything(), expect.anything());
  });

  it("rejects a keyed receipt that does not match the exact dispatched head", async () => {
    const sdk = memberMocks.createMemberSdk();
    const original = await sdk.createMemberKeyedTaskChat("org-b", {
      mode: "keyed_task",
      initialMessage: {
        format: "markdown",
        content: "fixture",
        metadata: JSON.parse(metadataJson()) as never,
      },
    });
    sdk.createMemberKeyedTaskChat.mockResolvedValueOnce({
      ...original,
      managedReviewReceiptV1: { ...original.managedReviewReceiptV1, expectedHead: "b".repeat(40) },
    });

    await expect(
      runCreate(["create", "opening", "--as-member", "--format", "markdown", "--metadata-file", "packet.json"]),
    ).rejects.toMatchObject({ code: "MANAGED_REVIEW_RECEIPT_MISMATCH", exitCode: 2 });
    expect(outputMocks.success).not.toHaveBeenCalled();
  });
});
