import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentPruneCommand } from "../commands/agent/prune.js";
import { print } from "../core/output.js";

/**
 * `agent prune` over the REAL `removeLocalAgent` (unlike the lifecycle
 * suite, which mocks it): a stale alias symlink that resolves outside First
 * Tree state must fail closed — reported inline, non-zero exit code — while
 * the remaining stale entries are still removed and the symlink's target
 * stays untouched.
 */

const sdkMocks = vi.hoisted(() => ({ listMyAgents: vi.fn() }));

vi.mock("@first-tree/client", async (importActual) => ({
  ...(await importActual<typeof import("@first-tree/client")>()),
  FirstTreeHubSDK: class {
    listMyAgents = () => sdkMocks.listMyAgents();
  },
}));

vi.mock("../commands/_shared/local-agent.js", () => ({
  readClientId: () => "client_self",
}));

describe("agent prune with real removeLocalAgent", () => {
  let home: string;
  let outside: string;
  let printLines: string[];
  let printSpy: ReturnType<typeof vi.spyOn>;
  const originalHome = process.env.FIRST_TREE_HOME;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fthub-prune-cmd-home-"));
    outside = mkdtempSync(join(tmpdir(), "fthub-prune-cmd-outside-"));
    process.env.FIRST_TREE_HOME = home;
    printLines = [];
    printSpy = vi.spyOn(print, "line").mockImplementation((text: string) => {
      printLines.push(text);
    });
    sdkMocks.listMyAgents.mockResolvedValue([]);
  });

  afterEach(() => {
    printSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    process.exitCode = originalExitCode;
  });

  async function runPrune(): Promise<void> {
    const program = new Command();
    const agent = program.command("agent");
    registerAgentPruneCommand(agent);
    await program.parseAsync(["node", "test", "agent", "prune", "--yes", "--server", "https://hub.example"]);
  }

  function writeStaleAlias(agentsDir: string, name: string): void {
    mkdirSync(join(agentsDir, name), { recursive: true });
    writeFileSync(join(agentsDir, name, "agent.yaml"), `agentId: 00000000-0000-0000-0000-00000000${name.slice(-4)}\n`);
  }

  it("keeps pruning past an alias resolving outside First Tree state and exits non-zero", async (ctx) => {
    const agentsDir = join(home, "config", "agents");
    writeStaleAlias(agentsDir, "stale-aaaa");
    writeStaleAlias(agentsDir, "stale-zzzz");
    mkdirSync(join(outside, "target"), { recursive: true });
    writeFileSync(join(outside, "target", "data.txt"), "keep");
    try {
      symlinkSync(join(outside, "target"), join(agentsDir, "escape"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    await runPrune();

    const output = printLines.join("");
    expect(output).toContain("✓ removed stale-aaaa");
    expect(output).toContain("✓ removed stale-zzzz");
    expect(output).toContain('✗ escape (Refusing to remove "escape": resolves outside First Tree state)');
    expect(output).toContain("2 pruned, 1 failed");
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(agentsDir, "stale-aaaa"))).toBe(false);
    expect(existsSync(join(agentsDir, "stale-zzzz"))).toBe(false);
    expect(readdirSync(agentsDir)).toContain("escape");
    expect(existsSync(join(outside, "target", "data.txt"))).toBe(true);
  });
});
