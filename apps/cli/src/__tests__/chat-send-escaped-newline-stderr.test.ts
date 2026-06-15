import { Command } from "commander";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the escaped-newline guard at the REAL process-output boundary — no
 * mocks on the Print layer (`core/output.js`) or its `cli/output.js`
 * wrapper. The point of the guard is agent self-correction, and the agent
 * reads raw stderr: the copyable heredoc retry form must arrive as plain
 * multi-line text, while the failure envelope stays one machine-readable
 * JSON line. Mock-level tests cannot see this; this file asserts the actual
 * bytes written to stderr and the actual exit code.
 */

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

const docCaptureMock = vi.hoisted(() => ({
  captureOutboundDocs: vi.fn(),
}));

vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../core/doc-capture.js", () => docCaptureMock);

const originalChatId = process.env.FIRST_TREE_CHAT_ID;
const originalExit = process.exit;

async function runChatSend(args: string[]): Promise<void> {
  const { registerChatCommands } = await import("../commands/chat/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerChatCommands(program);
  await program.parseAsync(["node", "test", "chat", "send", ...args]);
}

describe("chat send escaped-newline guard — real stderr boundary", () => {
  let stderrChunks: string[];
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    docCaptureMock.captureOutboundDocs.mockImplementation(async (content: string) => ({ content }));
    localAgentMocks.createSdk.mockReturnValue({
      sendMessage: vi.fn(async () => ({ id: "msg-1" })),
    });
    stderrChunks = [];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write);
    process.exit = vi.fn(((code?: number) => {
      throw Object.assign(new Error("process.exit"), { exitCode: code });
    }) as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.exit = originalExit;
    if (originalChatId === undefined) {
      delete process.env.FIRST_TREE_CHAT_ID;
    } else {
      process.env.FIRST_TREE_CHAT_ID = originalChatId;
    }
  });

  it("writes a copyable multi-line heredoc hint plus a single-line JSON envelope, exits 2, sends nothing", async () => {
    await expect(runChatSend(["nova", "line1\\n\\n**title**\\nline3"])).rejects.toMatchObject({ exitCode: 2 });

    const stderr = stderrChunks.join("");

    // The retry form is pasteable as-is: real newlines, heredoc opener and
    // terminator on their own lines, no JSON escaping.
    expect(stderr).toContain("cat <<'EOF' | ");
    expect(stderr).toContain("chat send <name> -f markdown\n");
    expect(stderr).toContain("\n  EOF\n");
    expect(stderr).toContain("stdin is not checked");

    // The machine-readable envelope is exactly one line of valid JSON with
    // the stable error code, so scripted consumers keep parsing.
    const envelopeLine = stderrChunks.find((chunk) => chunk.startsWith('{"ok":false'));
    expect(envelopeLine).toBeDefined();
    expect(envelopeLine).not.toContain("\n".repeat(2));
    const envelope = JSON.parse(envelopeLine ?? "");
    expect(envelope).toMatchObject({ ok: false, error: { code: "ESCAPED_NEWLINES" } });

    // exit 2, and nothing reached the send path — no broken row written.
    expect(process.exit).toHaveBeenCalledWith(2);
    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
  });
});
