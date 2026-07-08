import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const treeSharedMocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
}));

const verifyMocks = vi.hoisted(() => ({
  verifyTreeRoot: vi.fn(),
}));

vi.mock("../core/bootstrap.js", () => ({
  ensureFreshAccessToken: bootstrapMocks.ensureFreshAccessToken,
  resolveServerUrl: bootstrapMocks.resolveServerUrl,
}));

vi.mock("../commands/tree/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/tree/shared.js")>();
  return {
    ...actual,
    runCommand: treeSharedMocks.runCommand,
  };
});

vi.mock("../commands/tree/verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/tree/verify.js")>();
  return {
    ...actual,
    verifyTreeRoot: verifyMocks.verifyTreeRoot,
  };
});

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-tree-init-verify-"));
  tempDirs.push(dir);
  return dir;
}

function commandWithOptions(options: Record<string, unknown>): Command {
  const command = new Command("init");
  for (const [key, value] of Object.entries(options)) {
    command.setOptionValue(key, value);
  }
  return command;
}

function context(command: Command): CommandContext {
  return { command, options: { debug: false, json: false, quiet: false } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://server.example");
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("access-token");
  treeSharedMocks.runCommand.mockImplementation((tool: string, args: string[]) => {
    if (args[0] === "--version" || (tool === "gh" && args[0] === "auth" && args[1] === "status")) return "";
    if (tool === "gh" && args[0] === "api" && args[1] === "user") return "octocat";
    if (tool === "gh" && args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
      return JSON.stringify({ html_url: `https://github.com/${args[1].slice("repos/".length)}` });
    }
    return "";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree init verify failure", () => {
  it("stops before remote creation when the scaffolded tree does not verify", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    verifyMocks.verifyTreeRoot.mockReturnValue({
      ok: false,
      checks: {
        nodes: { ok: false, errors: ["NODE.md: missing title", "members/alice/NODE.md: missing role"] },
        members: { ok: true, errors: [] },
      },
    });

    await initCommand.action(context(commandWithOptions({ bind: false, title: "Broken" })));

    expect(process.exitCode).toBe(1);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain("Scaffolded tree failed `tree verify`");
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain("members/alice/NODE.md: missing role");
    expect(
      treeSharedMocks.runCommand.mock.calls.some(
        ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
      ),
    ).toBe(false);
  });
});
