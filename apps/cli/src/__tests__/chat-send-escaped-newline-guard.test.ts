import { EventEmitter } from "node:events";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { looksLikeEscapedNewlineBody } from "../commands/chat/_shared/io.js";

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

/**
 * Pins the `chat send` escaped-newline guard. Shell-composing models
 * routinely write the whole multi-line body as ONE quoted argument with
 * `\n` escapes — POSIX shells do not expand `\n` inside quotes, so the
 * literal two-character sequence reaches the server and the web UI renders
 * one long unformatted line. The guard rejects exactly that shape BEFORE
 * anything is sent, with a stderr hint actionable enough that the agent can
 * retry via stdin/heredoc and succeed in the same session.
 */
describe("looksLikeEscapedNewlineBody", () => {
  it("matches the observed failure shape — many escaped \\n, zero real newlines", () => {
    // Verbatim prefix of an incident message (codex agent, one-line send).
    const body = "更通俗地说：现在有两套文件夹。\\n\\n**第一套：公共阅读本**\\n就是 workspace 里的：\\n`context-tree`";
    expect(looksLikeEscapedNewlineBody(body)).toBe(true);
  });

  it("matches a minimal two-paragraph escaped body", () => {
    expect(looksLikeEscapedNewlineBody("para one\\n\\npara two")).toBe(true);
  });

  it("leaves bodies with real newlines alone — heredoc / stdin / ANSI-C $'...' shapes", () => {
    expect(looksLikeEscapedNewlineBody("para one\n\npara two")).toBe(false);
    // Mixed: discusses the escape sequence inside an otherwise real-newline body.
    expect(looksLikeEscapedNewlineBody("the bug: `\\n` vs `\\r\\n`\nsecond line")).toBe(false);
  });

  it("leaves a single \\n mention in one-line prose alone", () => {
    expect(looksLikeEscapedNewlineBody("split the value on \\n before parsing")).toBe(false);
  });

  it("leaves plain one-line bodies alone", () => {
    expect(looksLikeEscapedNewlineBody("done — PR #123 is green, merging now")).toBe(false);
    expect(looksLikeEscapedNewlineBody("")).toBe(false);
  });
});

const originalChatId = process.env.FIRST_TREE_CHAT_ID;
const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");

/**
 * Stdin stand-in that replays its body once `readStdin` attaches the `end`
 * listener — the command action runs asynchronously, so emitting eagerly
 * would race the listener registration.
 */
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
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: stdin,
  });
}

async function runChatSend(args: string[]): Promise<void> {
  const { registerChatCommands } = await import("../commands/chat/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerChatCommands(program);
  await program.parseAsync(["node", "test", "chat", "send", ...args]);
}

describe("chat send escaped-newline guard — intercept then self-correct", () => {
  // The exact body shape from the incident: what the shell hands the CLI
  // after `chat send nova "line1\n\n**title**\nline3"` — backslash-n stays
  // two literal characters.
  const escapedBody = "line1\\n\\n**title**\\nline3";
  const realBody = "line1\n\n**title**\nline3";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    docCaptureMock.captureOutboundDocs.mockImplementation(async (content: string) => ({ content }));
    localAgentMocks.createSdk.mockReturnValue({
      sendMessage: vi.fn(async () => ({ id: "msg-1" })),
    });
  });

  afterEach(() => {
    if (originalChatId === undefined) {
      delete process.env.FIRST_TREE_CHAT_ID;
    } else {
      process.env.FIRST_TREE_CHAT_ID = originalChatId;
    }
    if (originalStdinDescriptor) {
      Object.defineProperty(process, "stdin", originalStdinDescriptor);
    }
  });

  it("rejects the inline escaped body before anything is sent (non-zero exit, no row written)", async () => {
    await expect(runChatSend(["nova", escapedBody])).rejects.toMatchObject({
      code: "ESCAPED_NEWLINES",
      exitCode: 2,
    });

    // Nothing reached the server — no half-written or broken-format message.
    const sdk = localAgentMocks.createSdk.mock.results[0]?.value;
    expect(sdk?.sendMessage ?? localAgentMocks.createSdk).not.toHaveBeenCalled();
    expect(outputMocks.success).not.toHaveBeenCalled();
  });

  it("tells the agent exactly how to retry — copyable heredoc + stdin escape hatch", async () => {
    await expect(runChatSend(["nova", escapedBody])).rejects.toThrow();

    const message = outputMocks.fail.mock.calls[0]?.[1] ?? "";
    expect(message).toContain("cat <<'EOF'");
    expect(message).toContain("chat send <name> -f markdown");
    expect(message).toContain("stdin is not checked");
  });

  it("retry via stdin with real newlines succeeds and preserves markdown formatting", async () => {
    // First attempt: intercepted.
    await expect(runChatSend(["nova", escapedBody])).rejects.toMatchObject({ code: "ESCAPED_NEWLINES" });

    // Second attempt — the agent follows the hint and pipes the same content
    // through stdin with real newlines (heredoc shape).
    setProcessStdin(new MockStdin(realBody));
    await runChatSend(["nova", "-f", "markdown"]);

    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat-env",
      expect.objectContaining({ content: realBody, format: "markdown" }),
    );
    // The stored body carries REAL newlines (markdown renders) and no
    // literal backslash-n leftovers.
    const sentContent = sdk.sendMessage.mock.calls[0][1].content;
    expect(sentContent).toContain("\n\n**title**");
    expect(sentContent).not.toContain("\\n");
    expect(outputMocks.success).toHaveBeenCalledWith({ id: "msg-1" });
  });

  it("does not intercept a literal-\\n body piped via stdin (escape hatch)", async () => {
    setProcessStdin(new MockStdin(escapedBody));
    await runChatSend(["nova"]);

    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    expect(sdk.sendMessage).toHaveBeenCalledWith("chat-env", expect.objectContaining({ content: escapedBody }));
  });
});
