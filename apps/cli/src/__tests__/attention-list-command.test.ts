import type { Attention } from "@first-tree/shared";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSdkMock = vi.fn();
const failMock = vi.fn();
const handleSdkErrorMock = vi.fn();
const listAttentionsMock = vi.fn();
const printLineMock = vi.fn();
const successMock = vi.fn();

const openAttention: Attention = {
  id: "att-open-1234567890",
  originAgentId: "agent-origin",
  originChatId: "chat-a",
  targetHumanId: "human-1",
  subject: "Need release approval before cutting the production tag",
  body: "Please approve.",
  requiresResponse: true,
  state: "open",
  response: null,
  respondedBy: null,
  respondedAt: null,
  cancelled: false,
  cancelledReason: null,
  createdAt: "2026-05-28T10:00:00.000Z",
  closedAt: null,
  metadata: {},
};

const closedAttention: Attention = {
  ...openAttention,
  id: "att-closed-1234567890",
  originChatId: "chat-b",
  subject: `FYI ${"x".repeat(80)}`,
  requiresResponse: false,
  state: "closed",
  createdAt: "2026-05-27T10:00:00.000Z",
  closedAt: "2026-05-27T11:00:00.000Z",
};

async function loadCommand(): Promise<Command> {
  vi.doMock("../cli/output.js", () => ({
    fail: failMock,
    success: successMock,
  }));
  vi.doMock("../commands/_shared/local-agent.js", () => ({
    createSdk: createSdkMock,
    handleSdkError: handleSdkErrorMock,
  }));
  vi.doMock("../core/attention/index.js", () => ({
    listAttentions: listAttentionsMock,
  }));
  vi.doMock("../core/output.js", () => ({
    print: { line: printLineMock },
  }));

  const { registerAttentionListCommand } = await import("../commands/attention/list.js");
  const program = new Command();
  program.exitOverride();
  registerAttentionListCommand(program);
  return program;
}

describe("attention list command", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    createSdkMock.mockReturnValue({ agentId: "agent-me" });
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    handleSdkErrorMock.mockImplementation((error: unknown) => {
      throw error;
    });
    listAttentionsMock.mockResolvedValue([closedAttention, openAttention]);
  });

  it("defaults to the calling agent and can render chat-grouped output", async () => {
    const program = await loadCommand();

    await program.parseAsync(["list", "--group-by-chat"], { from: "user" });

    expect(createSdkMock).toHaveBeenCalledWith(undefined);
    expect(listAttentionsMock).toHaveBeenCalledWith({ agentId: "agent-me" }, { agent: "agent-me" });
    expect(successMock).toHaveBeenCalledWith([closedAttention, openAttention]);

    const grouped = printLineMock.mock.calls.flat().join("");
    expect(grouped).toContain("chat chat-a");
    expect(grouped).toContain("1 open ask");
    expect(grouped).toContain("! ask");
    expect(grouped).toContain("\u00b7 note");
    expect(grouped).toContain("FYI ");
  });

  it("honors explicit filters and parses the limit", async () => {
    const program = await loadCommand();

    await program.parseAsync(
      [
        "list",
        "--agent",
        "atlas",
        "--state",
        "all",
        "--from-agent",
        "agent-origin",
        "--in-chat",
        "chat-123",
        "--limit",
        "25",
      ],
      { from: "user" },
    );

    expect(createSdkMock).toHaveBeenCalledWith("atlas");
    expect(listAttentionsMock).toHaveBeenCalledWith(
      { agentId: "agent-me" },
      { state: "all", chat: "chat-123", agent: "agent-origin", limit: 25 },
    );
    expect(printLineMock).not.toHaveBeenCalled();
  });

  it("rejects invalid state, invalid limit, and missing agent context", async () => {
    const program = await loadCommand();

    await expect(program.parseAsync(["list", "--state", "pending"], { from: "user" })).rejects.toThrow(
      'INVALID_STATE:--state must be one of: open, closed, all (got "pending").',
    );

    await expect(program.parseAsync(["list", "--limit", "500"], { from: "user" })).rejects.toThrow(
      "INVALID_LIMIT:Limit must be between 1 and 200.",
    );

    createSdkMock.mockReturnValueOnce({ agentId: undefined });
    await expect(program.parseAsync(["list"], { from: "user" })).rejects.toThrow(
      "AGENT_REQUIRED:Could not determine the calling agent.",
    );
  });

  it("sorts grouped attention blocks by open asks and newest rows first", async () => {
    const { renderGroupedByChat } = await import("../commands/attention/list.js");

    const rows: Attention[] = [
      { ...closedAttention, originChatId: "chat-many", createdAt: "2026-05-27T10:00:00.000Z" },
      { ...openAttention, id: "att-old-open", originChatId: "chat-many", createdAt: "2026-05-28T09:00:00.000Z" },
      { ...openAttention, id: "att-new-open", originChatId: "chat-many", createdAt: "2026-05-28T11:00:00.000Z" },
      { ...closedAttention, originChatId: "chat-none", createdAt: "2026-05-28T12:00:00.000Z" },
    ];

    const rendered = [...renderGroupedByChat(rows)].join("");

    expect(rendered.indexOf("chat chat-many")).toBeLessThan(rendered.indexOf("chat chat-none"));
    expect(rendered.indexOf("att-new-")).toBeLessThan(rendered.indexOf("att-old-"));
    expect(rendered).toContain("FYI xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\u2026");
  });
});
