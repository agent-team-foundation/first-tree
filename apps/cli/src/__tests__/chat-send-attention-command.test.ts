import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captureOutboundDocsMock = vi.fn();
const createSdkMock = vi.fn();
const failMock = vi.fn();
const handleSdkErrorMock = vi.fn();
const printLineMock = vi.fn();
const readStdinMock = vi.fn();
const respondAttentionMock = vi.fn();
const sendMessageMock = vi.fn();
const successMock = vi.fn();

class AttentionRespondErrorMock extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function loadChatSendCommand(): Promise<Command> {
  vi.doMock("../cli/output.js", () => ({
    fail: failMock,
    success: successMock,
  }));
  vi.doMock("../commands/_shared/local-agent.js", () => ({
    createSdk: createSdkMock,
    handleSdkError: handleSdkErrorMock,
  }));
  vi.doMock("../commands/chat/_shared/io.js", () => ({
    readStdin: readStdinMock,
  }));
  vi.doMock("../core/doc-capture.js", () => ({
    captureOutboundDocs: captureOutboundDocsMock,
  }));

  const { registerChatSendCommand } = await import("../commands/chat/send.js");
  const program = new Command();
  program.exitOverride();
  registerChatSendCommand(program);
  return program;
}

async function loadAttentionRespondCommand(): Promise<Command> {
  vi.doMock("../cli/output.js", () => ({
    fail: failMock,
    success: successMock,
  }));
  vi.doMock("../core/attention/index.js", () => ({
    AttentionRespondError: AttentionRespondErrorMock,
    respondAttention: respondAttentionMock,
  }));
  vi.doMock("../core/output.js", () => ({
    print: { line: printLineMock },
  }));

  const { registerAttentionRespondCommand } = await import("../commands/attention/respond.js");
  const program = new Command();
  program.exitOverride();
  registerAttentionRespondCommand(program);
  return program;
}

describe("chat send and attention respond commands", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    captureOutboundDocsMock.mockImplementation(async (content: string) => ({ content }));
    createSdkMock.mockReturnValue({ sendMessage: sendMessageMock });
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    handleSdkErrorMock.mockImplementation((error: unknown) => {
      throw error;
    });
    readStdinMock.mockResolvedValue(null);
    respondAttentionMock.mockResolvedValue({ id: "att-1", state: "closed" });
    sendMessageMock.mockResolvedValue({ id: "msg-1" });
  });

  it("sends explicit chat messages with metadata and captured document context", async () => {
    vi.stubEnv("FIRST_TREE_CHAT_ID", "chat-1");
    captureOutboundDocsMock.mockResolvedValue({
      content: "Please read docs/README.md",
      documentContext: { kind: "snapshot", docs: [{ path: "docs/README.md", content: "# README" }] },
    });
    const program = await loadChatSendCommand();

    await program.parseAsync(
      [
        "send",
        "atlas",
        "Please read /repo/docs/README.md",
        "--format",
        "markdown",
        "--metadata",
        '{"priority":"high"}',
        "--agent",
        "sender",
      ],
      { from: "user" },
    );

    expect(createSdkMock).toHaveBeenCalledWith("sender");
    expect(sendMessageMock).toHaveBeenCalledWith("chat-1", {
      content: "Please read docs/README.md",
      format: "markdown",
      metadata: {
        priority: "high",
        documentContext: { kind: "snapshot", docs: [{ path: "docs/README.md", content: "# README" }] },
      },
      receiverNames: ["atlas"],
      source: "cli",
    });
    expect(successMock).toHaveBeenCalledWith({ id: "msg-1" });
  });

  it("reads chat send content from stdin and rejects invalid shell inputs", async () => {
    vi.stubEnv("FIRST_TREE_CHAT_ID", "chat-1");
    readStdinMock.mockResolvedValueOnce("piped message");
    const program = await loadChatSendCommand();

    await program.parseAsync(["send", "atlas"], { from: "user" });

    expect(sendMessageMock).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ content: "piped message", receiverNames: ["atlas"] }),
    );

    await expect(
      program.parseAsync(["send", "atlas", "hello", "--metadata", "not-json"], { from: "user" }),
    ).rejects.toThrow("INVALID_METADATA:Metadata must be valid JSON.");
    await expect(program.parseAsync(["send", "atlas"], { from: "user" })).rejects.toThrow(
      "NO_MESSAGE:No message provided.",
    );

    vi.unstubAllEnvs();
    await expect(program.parseAsync(["send", "atlas", "hello"], { from: "user" })).rejects.toThrow(
      "NO_CHAT_CONTEXT:`chat send` must be run from within an agent session",
    );
  });

  it("responds to attentions with text or structured answers", async () => {
    const program = await loadAttentionRespondCommand();

    await program.parseAsync(["respond", "att-1", "--text", "Approved", "--answer", "choice=yes"], { from: "user" });
    expect(printLineMock).toHaveBeenCalledWith(
      "warning: both --text and --answer provided; --text wins, --answer ignored.\n",
    );
    expect(respondAttentionMock).toHaveBeenCalledWith({ id: "att-1", text: "Approved", answers: undefined });
    expect(successMock).toHaveBeenCalledWith({ id: "att-1", state: "closed" });

    respondAttentionMock.mockClear();
    await program.parseAsync(["respond", "att-2", "--answer", "choice=yes", "--answer", "note=ship"], {
      from: "user",
    });
    expect(respondAttentionMock).toHaveBeenCalledWith({
      id: "att-2",
      text: undefined,
      answers: { choice: "yes", note: "ship" },
    });
  });

  it("maps attention response validation and HTTP errors to CLI failures", async () => {
    const program = await loadAttentionRespondCommand();

    await expect(program.parseAsync(["respond", "att-1"], { from: "user" })).rejects.toThrow("UNKNOWN_ERROR");
    expect(failMock).toHaveBeenCalledWith(
      "RESPONSE_REQUIRED",
      "Pass either --text <...> or one or more --answer key=value flags.",
      2,
    );

    failMock.mockClear();
    await expect(program.parseAsync(["respond", "att-1", "--answer", "bad"], { from: "user" })).rejects.toThrow(
      "UNKNOWN_ERROR",
    );
    expect(failMock).toHaveBeenCalledWith("INVALID_ANSWER", 'Bad --answer value "bad". Expected "key=value".', 2);

    failMock.mockClear();
    respondAttentionMock.mockRejectedValueOnce(new AttentionRespondErrorMock(401, "login required"));
    await expect(program.parseAsync(["respond", "att-1", "--text", "Approved"], { from: "user" })).rejects.toThrow(
      "HTTP_401:login required",
    );
    expect(failMock).toHaveBeenCalledWith("HTTP_401", "login required", 3);
  });
});
