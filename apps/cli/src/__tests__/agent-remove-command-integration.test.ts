import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentRemoveCommand } from "../commands/agent/remove.js";
import { setJsonMode } from "../core/output.js";

const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalFirstTreeHome = process.env.FIRST_TREE_HOME;

let testRoot: string;
let home: string;
let stderrChunks: string[];
let stderrSpy: MockInstance<typeof process.stderr.write>;

async function runRemove(name: string): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  const agent = program.command("agent");
  registerAgentRemoveCommand(agent);
  await program.parseAsync(["node", "test", "agent", "remove", name]);
}

function createOrphanState(name: string): { session: string; workspace: string; workspaceSentinel: string } {
  const workspace = join(home, "data", "workspaces", name);
  const workspaceSentinel = join(workspace, "keep.txt");
  const session = join(home, "data", "sessions", `${name}.json`);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(home, "data", "sessions"), { recursive: true });
  writeFileSync(workspaceSentinel, "keep-workspace");
  writeFileSync(session, "keep-session");
  return { session, workspace, workspaceSentinel };
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "first-tree-agent-remove-command-"));
  home = join(testRoot, "home");
  mkdirSync(join(home, "config", "agents"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  process.exitCode = undefined;
  process.exit = vi.fn(((code?: number) => {
    throw Object.assign(new Error("process.exit"), { exitCode: code });
  }) as never);
  setJsonMode(false);
  stderrChunks = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  stderrSpy.mockRestore();
  process.exit = originalExit;
  process.exitCode = originalExitCode;
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  setJsonMode(false);
  rmSync(testRoot, { recursive: true, force: true });
});

describe("agent remove command filesystem semantics", () => {
  it("preserves orphan workspace and session state when the configuration alias is missing", async () => {
    const orphan = createOrphanState("alpha");

    await expect(runRemove("alpha")).rejects.toMatchObject({ exitCode: 1 });

    expect(stderrChunks.join("")).toContain('Agent "alpha" not found.');
    expect(existsSync(orphan.workspace)).toBe(true);
    expect(readFileSync(orphan.workspaceSentinel, "utf8")).toBe("keep-workspace");
    expect(readFileSync(orphan.session, "utf8")).toBe("keep-session");
  });

  it.skipIf(process.platform === "win32")(
    "routes a dangling configuration alias into core fail-closed checks",
    async () => {
      const orphan = createOrphanState("alpha");
      const alias = join(home, "config", "agents", "alpha");
      symlinkSync(join(testRoot, "missing-alias-target"), alias);

      await expect(runRemove("alpha")).rejects.toMatchObject({ exitCode: 1 });

      const output = stderrChunks.join("");
      expect(output).toContain("Unable to verify the local agent configuration safely (ENOENT).");
      expect(output).not.toContain(testRoot);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(readFileSync(orphan.workspaceSentinel, "utf8")).toBe("keep-workspace");
      expect(readFileSync(orphan.session, "utf8")).toBe("keep-session");
    },
  );
});
