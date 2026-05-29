import type { Attention } from "@first-tree/shared";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attentionMocks = vi.hoisted(() => ({
  listAttentions: vi.fn(),
}));

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

const printLineMock = vi.hoisted(() => vi.fn());

vi.mock("../core/attention/index.js", () => attentionMocks);
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/output.js", () => ({
  print: { line: printLineMock },
}));

function attention(overrides: Partial<Attention> = {}): Attention {
  return {
    id: overrides.id ?? "attention-123456789",
    originAgentId: overrides.originAgentId ?? "agent-1",
    originChatId: overrides.originChatId ?? "chat-1",
    targetHumanId: overrides.targetHumanId ?? "human-1",
    subject: overrides.subject ?? "Choose release window",
    body: overrides.body ?? "",
    requiresResponse: overrides.requiresResponse ?? true,
    state: overrides.state ?? "open",
    response: overrides.response ?? null,
    respondedBy: overrides.respondedBy ?? null,
    respondedAt: overrides.respondedAt ?? null,
    cancelled: overrides.cancelled ?? false,
    cancelledReason: overrides.cancelledReason ?? null,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? "2026-05-28T12:00:00.000Z",
    closedAt: overrides.closedAt ?? null,
  };
}

async function runList(args: string[] = []): Promise<void> {
  const { registerAttentionListCommand } = await import("../commands/attention/list.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  const attentionCommand = program.command("attention");
  registerAttentionListCommand(attentionCommand);
  await program.parseAsync(["node", "test", "attention", "list", ...args]);
}

describe("attention list command", () => {
  beforeEach(() => {
    attentionMocks.listAttentions.mockReset();
    localAgentMocks.createSdk.mockReset();
    localAgentMocks.handleSdkError.mockClear();
    outputMocks.fail.mockClear();
    outputMocks.success.mockClear();
    printLineMock.mockClear();

    localAgentMocks.createSdk.mockReturnValue({ agentId: "agent-self" });
    attentionMocks.listAttentions.mockResolvedValue([attention()]);
  });

  it("defaults to attentions raised by the resolved local agent", async () => {
    await runList();

    expect(localAgentMocks.createSdk).toHaveBeenCalledWith(undefined);
    expect(attentionMocks.listAttentions).toHaveBeenCalledWith({ agentId: "agent-self" }, { agent: "agent-self" });
    expect(outputMocks.success).toHaveBeenCalledWith([expect.objectContaining({ id: "attention-123456789" })]);
  });

  it("validates filters and forwards explicit query options", async () => {
    await runList([
      "--agent",
      "kael",
      "--state",
      "closed",
      "--from-agent",
      "agent-origin",
      "--in-chat",
      "chat-1",
      "--limit",
      "25",
    ]);

    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("kael");
    expect(attentionMocks.listAttentions).toHaveBeenCalledWith(
      { agentId: "agent-self" },
      { agent: "agent-origin", chat: "chat-1", limit: 25, state: "closed" },
    );

    await expect(runList(["--state", "weird"])).rejects.toMatchObject({ code: "INVALID_STATE", exitCode: 2 });
    await expect(runList(["--limit", "999"])).rejects.toMatchObject({ code: "INVALID_LIMIT", exitCode: 2 });
  });

  it("renders chat grouping and handles missing agent context", async () => {
    attentionMocks.listAttentions.mockResolvedValueOnce([
      attention({
        id: "open-ask-123456",
        originChatId: "chat-b",
        subject: "Open ask",
        createdAt: "2026-05-28T12:02:00.000Z",
      }),
      attention({
        id: "closed-note-123456",
        originChatId: "chat-a",
        subject: "Closed note",
        requiresResponse: false,
        state: "closed",
        createdAt: "2026-05-28T12:01:00.000Z",
      }),
    ]);

    await runList(["--group-by-chat"]);

    const grouped = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(grouped).toContain("chat chat-b  (1 open ask)");
    expect(grouped).toContain("! ask");
    expect(grouped).toContain("chat chat-a");
    expect(grouped).toContain("· note");

    localAgentMocks.createSdk.mockReturnValueOnce({});
    await expect(runList()).rejects.toMatchObject({ code: "AGENT_REQUIRED", exitCode: 2 });
  });

  it("delegates SDK failures to the shared SDK error mapper", async () => {
    const error = new Error("network down");
    attentionMocks.listAttentions.mockRejectedValueOnce(error);

    await expect(runList()).rejects.toThrow("network down");
    expect(localAgentMocks.handleSdkError).toHaveBeenCalledWith(error);
  });
});
