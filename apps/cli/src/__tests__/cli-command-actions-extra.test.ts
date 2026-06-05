import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const printMocks = vi.hoisted(() => ({
  line: vi.fn(),
}));

const doctorMocks = vi.hoisted(() => ({
  printResults: vi.fn(),
  runDaemonChecks: vi.fn(),
}));

const statusBlockMocks = vi.hoisted(() => ({
  renderAgentsBlock: vi.fn(),
  renderAuthBlock: vi.fn(),
  renderCliVersionBlock: vi.fn(),
  renderHubBlock: vi.fn(),
  renderServiceBlock: vi.fn(),
}));

vi.mock("../core/output.js", () => ({ print: printMocks }));
vi.mock("../core/index.js", () => ({ printResults: doctorMocks.printResults }));
vi.mock("../commands/_shared/doctor-checks.js", () => ({ runDaemonChecks: doctorMocks.runDaemonChecks }));
vi.mock("../commands/_shared/status-blocks.js", () => statusBlockMocks);

function command(root: Command, name: string): Command {
  const found = root.commands.find((entry) => entry.name() === name);
  if (!found) throw new Error(`Missing command ${name}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe("CLI command action coverage", () => {
  it("runs top-level status, daemon status, and doctor actions", async () => {
    const { registerDoctorCommand } = await import("../commands/doctor.js");
    const { registerStatusCommand } = await import("../commands/status.js");
    const { registerDaemonStatusCommand } = await import("../commands/daemon/status.js");

    const root = new Command();
    registerStatusCommand(root);
    registerDoctorCommand(root);
    const daemon = root.command("daemon");
    registerDaemonStatusCommand(daemon);

    await command(root, "status").parseAsync([], { from: "user" });
    expect(statusBlockMocks.renderCliVersionBlock).toHaveBeenCalled();
    expect(statusBlockMocks.renderServiceBlock).toHaveBeenCalledTimes(1);
    expect(statusBlockMocks.renderHubBlock).toHaveBeenCalledTimes(1);
    expect(statusBlockMocks.renderAuthBlock).toHaveBeenCalledTimes(1);
    expect(statusBlockMocks.renderAgentsBlock).toHaveBeenCalled();

    await command(daemon, "status").parseAsync([], { from: "user" });
    expect(statusBlockMocks.renderServiceBlock).toHaveBeenCalledTimes(2);
    expect(printMocks.line.mock.calls.map((call) => String(call[0])).join("")).toContain("\n");

    const results = [{ label: "Node", ok: true, detail: "v24" }];
    doctorMocks.runDaemonChecks.mockResolvedValueOnce(results);
    await command(root, "doctor").parseAsync([], { from: "user" });
    expect(doctorMocks.printResults).toHaveBeenCalledWith(results);
  });

  // The `tree review` action and its three exit-code paths were exercised
  // here pre-2026-06. The command was deleted along with the rest of the
  // `first-tree tree` namespace (except `verify`); nothing about the
  // remaining CLI surface still needs this coverage.
});
