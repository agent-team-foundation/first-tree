import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  FirstTreeHubSDK: vi.fn(),
  SdkError: class SdkError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
  })),
}));

const configMocks = vi.hoisted(() => ({
  agentConfigSchema: {},
  clientConfigSchema: {},
  defaultConfigDir: vi.fn(),
  loadAgents: vi.fn(),
  resolveConfigReadonly: vi.fn(),
}));

const bootstrapMocks = vi.hoisted(() => ({
  AuthRefreshFailedError: class AuthRefreshFailedError extends Error {},
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

vi.mock("@first-tree/client", () => clientMocks);
vi.mock("@first-tree/shared/config", () => configMocks);
vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../cli/output.js", () => outputMocks);

describe("org context-tree local agent resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.FIRST_TREE_AGENT_ID;
    configMocks.defaultConfigDir.mockReturnValue("/tmp/first-tree-config");
    configMocks.resolveConfigReadonly.mockReturnValue({});
    bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("token");
    bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
    clientMocks.FirstTreeHubSDK.mockImplementation((config: { agentId?: string }) => ({
      agentId: config.agentId,
      getAgentContextTreeConfig: vi.fn(async () => ({
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
      })),
    }));
  });

  async function parse(options: string[] = []): Promise<void> {
    const { registerOrgContextTreeCommand } = await import("../commands/org/context-tree.js");
    const program = new Command();
    registerOrgContextTreeCommand(program);
    await program.parseAsync(["node", "first-tree", "context-tree", ...options]);
  }

  it("creates its logger after command preAction config is applied", async () => {
    const events: string[] = [];
    configMocks.loadAgents.mockReturnValue(new Map([["writer", { agentId: "agent-writer" }]]));
    clientMocks.createLogger.mockImplementationOnce(() => {
      events.push("logger");
      return { debug: vi.fn(), warn: vi.fn() };
    });

    const { registerOrgContextTreeCommand } = await import("../commands/org/context-tree.js");
    expect(clientMocks.createLogger).not.toHaveBeenCalled();

    const program = new Command();
    program.hook("preAction", () => {
      events.push("preAction");
    });
    registerOrgContextTreeCommand(program);
    await program.parseAsync(["node", "first-tree", "context-tree"]);

    expect(events).toEqual(["preAction", "logger"]);
    expect(clientMocks.createLogger).toHaveBeenCalledWith("context-tree-binding");
  });

  it("uses an explicit local agent name before environment or singleton selection", async () => {
    process.env.FIRST_TREE_AGENT_ID = "agent-env";
    configMocks.loadAgents.mockReturnValue(
      new Map([
        ["writer", { agentId: "agent-writer" }],
        ["runner", { agentId: "agent-env" }],
      ]),
    );

    await parse(["--agent", "writer"]);

    expect(clientMocks.FirstTreeHubSDK).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-writer" }));
    expect(outputMocks.success).toHaveBeenCalledWith({
      status: "bound",
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
    });
  });

  it("uses FIRST_TREE_AGENT_ID when no explicit name is supplied", async () => {
    process.env.FIRST_TREE_AGENT_ID = "agent-runner";
    configMocks.loadAgents.mockReturnValue(
      new Map([
        ["writer", { agentId: "agent-writer" }],
        ["runner", { agentId: "agent-runner" }],
      ]),
    );

    await parse();

    expect(clientMocks.FirstTreeHubSDK).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-runner" }));
  });

  it("uses the only local agent when no environment selection exists", async () => {
    configMocks.loadAgents.mockReturnValue(new Map([["writer", { agentId: "agent-writer" }]]));

    await parse();

    expect(clientMocks.FirstTreeHubSDK).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-writer" }));
  });

  it.each([
    ["missing", new Map(), undefined, "MISSING_AGENT"],
    [
      "ambiguous",
      new Map([
        ["writer", { agentId: "agent-writer" }],
        ["runner", { agentId: "agent-runner" }],
      ]),
      undefined,
      "AMBIGUOUS_AGENT",
    ],
    [
      "environment mismatch",
      new Map([["writer", { agentId: "agent-writer" }]]),
      "agent-missing",
      "ENV_AGENT_NOT_LOCAL",
    ],
    ["unknown explicit", new Map([["writer", { agentId: "agent-writer" }]]), undefined, "UNKNOWN_AGENT"],
  ] as const)("fails %s before creating an SDK or making a request", async (_label, agents, envAgentId, code) => {
    configMocks.loadAgents.mockReturnValue(agents);
    if (envAgentId) process.env.FIRST_TREE_AGENT_ID = envAgentId;
    const args = code === "UNKNOWN_AGENT" ? ["--agent", "missing"] : [];

    await expect(parse(args)).rejects.toMatchObject({ code, exitCode: 2 });

    expect(clientMocks.FirstTreeHubSDK).not.toHaveBeenCalled();
    expect(bootstrapMocks.ensureFreshAccessToken).not.toHaveBeenCalled();
    expect(outputMocks.fail).toHaveBeenCalledWith(code, expect.any(String), 2);
  });
});
