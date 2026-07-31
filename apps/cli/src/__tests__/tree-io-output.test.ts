import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listAgentContextTreeIo = vi.hoisted(() => vi.fn());
const printResult = vi.hoisted(() => vi.fn());
const printLine = vi.hoisted(() => vi.fn());
const jsonMode = vi.hoisted(() => vi.fn(() => false));

vi.mock("../commands/_shared/local-agent.js", () => ({
  createSdk: () => ({ listAgentContextTreeIo }),
  handleSdkError: (error: unknown) => {
    throw error;
  },
}));
vi.mock("../core/output.js", () => ({
  isJsonMode: jsonMode,
  print: { result: printResult, line: printLine },
}));

const { runTreeIoCommand, treeIoCommand } = await import("../commands/tree/io.js");

function context(options: Record<string, unknown> = {}) {
  const command = new Command();
  treeIoCommand.configure?.(command);
  command.setOptionValueWithSource = command.setOptionValueWithSource.bind(command);
  for (const [key, value] of Object.entries(options)) command.setOptionValue(key, value);
  return { command, options: { json: false } } as never;
}

const event = (path: string) => ({
  id: `io-${path}`,
  chatId: "chat-1",
  action: "read",
  source: "claude_read_tool",
  runtimeProvider: "claude-code",
  targetKind: "file",
  targetPath: path,
  treeRepoUrl: "https://github.com/acme/tree",
  treeBranch: "main",
  treeHeadCommit: null,
  createdAt: "2026-07-31T10:00:00.000Z",
});

describe("tree io human output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jsonMode.mockReturnValue(false);
  });

  it("terminates every row so entries do not run together", async () => {
    // `print.line` writes raw bytes to stderr and adds no newline of its own,
    // so a row without a trailing "\n" silently concatenates with the next one.
    listAgentContextTreeIo.mockResolvedValue({
      items: [event("system/a.md"), event("system/b.md")],
      nextCursor: null,
    });

    await runTreeIoCommand(context());

    const rows = printLine.mock.calls.map(([text]) => String(text));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.endsWith("\n")).toBe(true);
    }
    expect(rows.join("")).toContain("system/a.md");
    expect(rows.join("")).toContain("system/b.md");
  });

  it("terminates the empty-range and continuation notices too", async () => {
    listAgentContextTreeIo.mockResolvedValue({ items: [], nextCursor: null });
    await runTreeIoCommand(context());
    expect(String(printLine.mock.calls[0]?.[0])).toMatch(/\n$/);

    printLine.mockClear();
    listAgentContextTreeIo.mockResolvedValue({ items: [event("x.md")], nextCursor: "next-page" });
    await runTreeIoCommand(context());
    const last = String(printLine.mock.calls.at(-1)?.[0]);
    expect(last).toContain("--cursor next-page");
    expect(last.endsWith("\n")).toBe(true);
  });

  it("emits the structured envelope instead of rows in JSON mode", async () => {
    jsonMode.mockReturnValue(true);
    listAgentContextTreeIo.mockResolvedValue({ items: [event("system/a.md")], nextCursor: null });

    await runTreeIoCommand(context());

    expect(printLine).not.toHaveBeenCalled();
    expect(printResult).toHaveBeenCalledTimes(1);
    const payload = printResult.mock.calls[0]?.[0] as { items: unknown[]; nextCursor: string | null };
    expect(payload.items).toHaveLength(1);
    expect(payload.nextCursor).toBeNull();
  });
});
