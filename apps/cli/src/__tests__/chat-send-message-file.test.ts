import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

const docCaptureMock = vi.hoisted(() => ({
  captureOutboundDocs: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../core/doc-capture.js", () => docCaptureMock);
vi.mock("../cli/output.js", () => outputMocks);

const originalChatId = process.env.FIRST_TREE_CHAT_ID;
const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");

/** Stdin stand-in that replays its body once `readStdin` attaches `end`. */
class MockStdin extends EventEmitter {
  isTTY = false;
  destroy = vi.fn();

  constructor(private readonly body: string) {
    super();
  }

  override on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === "end") {
      queueMicrotask(() => {
        this.emit("data", Buffer.from(this.body, "utf-8"));
        this.emit("end");
      });
    }
    return this;
  }
}

function setProcessStdin(stdin: unknown): void {
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
}

async function runChat(kind: "send" | "ask", args: string[]): Promise<void> {
  const { registerChatCommands } = await import("../commands/chat/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerChatCommands(program);
  await program.parseAsync(["node", "test", "chat", kind, ...args]);
}

/**
 * Pins the `--message-file` / `-F` path for `chat send` and `chat ask`. This is
 * the shell-safe body channel: the content is read from a file (or stdin) and
 * reaches the server byte-for-byte, so backticks, quotes, apostrophes, and
 * newlines that an inline shell argument would mangle survive intact.
 */
describe("chat send/ask --message-file", () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    dir = mkdtempSync(join(tmpdir(), "ft-msgfile-"));
    docCaptureMock.captureOutboundDocs.mockImplementation(async (content: string) => ({ content }));
    localAgentMocks.createSdk.mockReturnValue({
      sendMessage: vi.fn(async () => ({ id: "msg-1" })),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalChatId === undefined) {
      delete process.env.FIRST_TREE_CHAT_ID;
    } else {
      process.env.FIRST_TREE_CHAT_ID = originalChatId;
    }
    if (originalStdinDescriptor) {
      Object.defineProperty(process, "stdin", originalStdinDescriptor);
    }
  });

  it("sends a file body verbatim — backticks, quotes, apostrophes, newlines all survive", async () => {
    // Exactly the shape the shell would mangle inline: backticks become command
    // substitution, double quotes terminate the arg, apostrophes break a
    // single-quoted retry.
    const body = 'status: ran `git pull` then `pnpm build`.\n\nIt\'s a "clean" pass — see `explores/[id]`.';
    const path = join(dir, "reply.md");
    writeFileSync(path, body);

    await runChat("send", ["code-agent", "-f", "markdown", "--message-file", path]);

    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat-env",
      expect.objectContaining({ content: body, format: "markdown" }),
    );
    expect(outputMocks.success).toHaveBeenCalledWith({ id: "msg-1" });
  });

  it("`-F -` reads the body from stdin", async () => {
    const body = 'piped `code` and "quotes" intact';
    setProcessStdin(new MockStdin(body));

    await runChat("send", ["code-agent", "-F", "-"]);

    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    expect(sdk.sendMessage).toHaveBeenCalledWith("chat-env", expect.objectContaining({ content: body }));
  });

  it("rejects a missing file (exit 2, nothing sent)", async () => {
    await expect(runChat("send", ["code-agent", "--message-file", join(dir, "nope.md")])).rejects.toMatchObject({
      code: "MESSAGE_FILE_NOT_FOUND",
      exitCode: 2,
    });
    expect(outputMocks.success).not.toHaveBeenCalled();
  });

  it("rejects combining an inline body with --message-file", async () => {
    const path = join(dir, "reply.md");
    writeFileSync(path, "body");

    await expect(runChat("send", ["code-agent", "inline body", "--message-file", path])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    expect(outputMocks.success).not.toHaveBeenCalled();
  });

  it("does NOT run the escaped-newline guard on a file body (a file may hold literal \\n)", async () => {
    // Inline, this exact string is rejected (ESCAPED_NEWLINES). From a file it
    // is a legitimate body and must pass through untouched.
    const body = "line1\\n\\n**title**\\nline3";
    const path = join(dir, "literal.md");
    writeFileSync(path, body);

    await runChat("send", ["code-agent", "-f", "markdown", "--message-file", path]);

    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    expect(sdk.sendMessage).toHaveBeenCalledWith("chat-env", expect.objectContaining({ content: body }));
  });

  it("chat ask also accepts --message-file", async () => {
    const body = "Background: `migration 0021` drops a column.\n\nShip it?";
    const path = join(dir, "ask.md");
    writeFileSync(path, body);

    await runChat("ask", ["alice", "--message-file", path]);

    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat-env",
      expect.objectContaining({ content: body, format: "request" }),
    );
  });
});
