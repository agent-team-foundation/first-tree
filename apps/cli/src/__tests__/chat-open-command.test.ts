import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ReadlineHandler = (line?: string) => unknown;

const cliFetchMock = vi.fn();
const clearIntervalMock = vi.fn();
const createInterfaceMock = vi.fn();
const ensureFreshAccessTokenMock = vi.fn();
const failMock = vi.fn();
const printLineMock = vi.fn();
const promptMock = vi.fn();
const resolveAgentMock = vi.fn();
const resolveServerUrlMock = vi.fn();
const setIntervalMock = vi.fn();
const readlineHandlers = new Map<string, ReadlineHandler>();

function response(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

async function loadProgram(): Promise<Command> {
  vi.doMock("node:readline", () => ({
    createInterface: createInterfaceMock,
  }));
  vi.doMock("../cli/output.js", () => ({
    fail: failMock,
  }));
  vi.doMock("../core/bootstrap.js", () => ({
    ensureFreshAccessToken: ensureFreshAccessTokenMock,
    resolveServerUrl: resolveServerUrlMock,
  }));
  vi.doMock("../core/cli-fetch.js", () => ({
    cliFetch: cliFetchMock,
  }));
  vi.doMock("../core/output.js", () => ({
    print: { line: printLineMock },
  }));
  vi.doMock("../commands/_shared/resolve-agent.js", () => ({
    resolveAgent: resolveAgentMock,
  }));

  const { registerChatOpenCommand } = await import("../commands/chat/open.js");
  const program = new Command();
  program.exitOverride();
  registerChatOpenCommand(program);
  return program;
}

describe("chat open command", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    readlineHandlers.clear();

    ensureFreshAccessTokenMock.mockResolvedValue("access-token");
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    resolveAgentMock.mockResolvedValue({ uuid: "agent-atlas", name: "atlas", displayName: "Atlas" });
    resolveServerUrlMock.mockReturnValue("https://hub.example.test");
    setIntervalMock.mockReturnValue(42);

    createInterfaceMock.mockReturnValue({
      on: vi.fn((event: string, handler: ReadlineHandler) => {
        readlineHandlers.set(event, handler);
      }),
      prompt: promptMock,
    });
    vi.stubGlobal("setInterval", setIntervalMock);
    vi.stubGlobal("clearInterval", clearIntervalMock);
  });

  it("opens a DM, polls messages, sends entered lines, and closes cleanly", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    const program = await loadProgram();
    cliFetchMock.mockResolvedValueOnce(response(true, 200, { id: "chat-1" })).mockResolvedValueOnce(
      response(true, 200, {
        items: [{ id: "msg-1", senderId: "agent-atlas", content: "hello", createdAt: "2026-05-28T10:00:00.000Z" }],
      }),
    );

    await program.parseAsync(["open", "atlas", "--server", "https://override.example.test"], { from: "user" });

    expect(resolveServerUrlMock).toHaveBeenCalledWith("https://override.example.test");
    expect(resolveAgentMock).toHaveBeenCalledWith("https://hub.example.test", "access-token", "atlas");
    expect(createInterfaceMock).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stderr,
      prompt: "  > ",
    });
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 2000);
    expect(printLineMock.mock.calls.flat().join("")).toContain("Chat with Atlas");

    const lineHandler = readlineHandlers.get("line");
    if (!lineHandler) throw new Error("missing line handler");

    await Promise.resolve(lineHandler("   "));
    expect(promptMock).toHaveBeenCalled();

    cliFetchMock.mockResolvedValueOnce(response(false, 500, "send failed"));
    await Promise.resolve(lineHandler("hello"));
    expect(printLineMock.mock.calls.flat().join("")).toContain("Failed to send: 500");

    cliFetchMock.mockResolvedValueOnce(response(true, 200, { createdAt: "2026-05-28T10:00:02.000Z" }));
    await Promise.resolve(lineHandler("second"));
    expect(cliFetchMock).toHaveBeenLastCalledWith(
      "https://hub.example.test/api/v1/chats/chat-1/messages",
      expect.objectContaining({
        body: JSON.stringify({ format: "text", content: "second" }),
        method: "POST",
      }),
    );

    const closeHandler = readlineHandlers.get("close");
    if (!closeHandler) throw new Error("missing close handler");
    expect(() => closeHandler()).toThrow("exit:0");
    expect(clearIntervalMock).toHaveBeenCalledWith(42);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("wraps DM creation failures in CHAT_ERROR", async () => {
    const program = await loadProgram();
    cliFetchMock.mockResolvedValueOnce(response(false, 503, "unavailable"));

    await expect(program.parseAsync(["open", "atlas"], { from: "user" })).rejects.toThrow(
      "CHAT_ERROR:DM_ERROR:Failed to create DM: 503",
    );
  });
});
