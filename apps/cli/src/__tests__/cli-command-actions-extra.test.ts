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

const reviewMock = vi.hoisted(() => vi.fn());

vi.mock("../core/output.js", () => ({ print: printMocks }));
vi.mock("../core/index.js", () => ({ printResults: doctorMocks.printResults }));
vi.mock("../commands/_shared/doctor-checks.js", () => ({ runDaemonChecks: doctorMocks.runDaemonChecks }));
vi.mock("../commands/_shared/status-blocks.js", () => statusBlockMocks);
vi.mock("../commands/tree/review-helper.js", () => ({ runTreeReview: reviewMock }));

function command(root: Command, name: string): Command {
  const found = root.commands.find((entry) => entry.name() === name);
  if (!found) throw new Error(`Missing command ${name}`);
  return found;
}

function commandWithOptions(options: Record<string, unknown>): Command {
  const cmd = new Command("test");
  for (const [key, value] of Object.entries(options)) {
    cmd.setOptionValue(key, value);
  }
  return cmd;
}

function context(command: Command) {
  return { command, options: { debug: false, json: false, quiet: false } };
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

  it("runs tree review action success, nonzero, and thrown-error paths", async () => {
    const { reviewCommand } = await import("../commands/tree/review.js");

    reviewMock.mockReturnValueOnce(0);
    reviewCommand.action(context(commandWithOptions({ diff: "pr.diff", output: "review.json" })));
    expect(reviewMock).toHaveBeenCalledWith({ diffPath: "pr.diff", outputPath: "review.json" });
    expect(process.exitCode).toBeUndefined();

    reviewMock.mockReturnValueOnce(2);
    reviewCommand.action(context(commandWithOptions({ diff: "pr.diff" })));
    expect(reviewMock).toHaveBeenLastCalledWith({ diffPath: "pr.diff" });
    expect(process.exitCode).toBe(2);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reviewMock.mockImplementationOnce(() => {
      throw new Error("review failed");
    });
    process.exitCode = undefined;
    reviewCommand.action(context(commandWithOptions({})));
    expect(error).toHaveBeenCalledWith("review failed");
    expect(process.exitCode).toBe(1);
  });
});
