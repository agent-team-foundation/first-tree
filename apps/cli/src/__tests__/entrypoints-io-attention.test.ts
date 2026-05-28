import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyClientLoggerConfigMock = vi.fn();
const cancelMock = vi.fn();
const cliFetchMock = vi.fn();
const ensureFreshAccessTokenMock = vi.fn();
const failMock = vi.fn();
const listMock = vi.fn();
const raiseMock = vi.fn();
const registerMocks = {
  agent: vi.fn(),
  attention: vi.fn(),
  chat: vi.fn(),
  config: vi.fn(),
  daemon: vi.fn(),
  doctor: vi.fn(),
  github: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  org: vi.fn(),
  status: vi.fn(),
  tree: vi.fn(),
  upgrade: vi.fn(),
};
const resolveServerUrlMock = vi.fn();
const setJsonModeMock = vi.fn();
const showMock = vi.fn();

let commandOptions: { json?: boolean; verbose?: boolean } = {};

class FakeCommand {
  hooks: Array<(command: FakeCommand) => void> = [];

  name(): FakeCommand {
    return this;
  }

  description(): FakeCommand {
    return this;
  }

  version(): FakeCommand {
    return this;
  }

  option(): FakeCommand {
    return this;
  }

  hook(_name: string, fn: (command: FakeCommand) => void): FakeCommand {
    this.hooks.push(fn);
    return this;
  }

  optsWithGlobals(): { json?: boolean; verbose?: boolean } {
    return commandOptions;
  }

  parse(): void {
    for (const hook of this.hooks) hook(this);
  }
}

function response(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

async function importCliEntrypoint(): Promise<void> {
  vi.doMock("@first-tree/client", () => ({
    applyClientLoggerConfig: applyClientLoggerConfigMock,
    FirstTreeHubSDK: class FirstTreeHubSDK {},
    SdkError: class SdkError extends Error {},
  }));
  vi.doMock("commander", () => ({ Command: FakeCommand }));
  vi.doMock("../commands/agent/index.js", () => ({ registerAgentCommands: registerMocks.agent }));
  vi.doMock("../commands/attention/index.js", () => ({ registerAttentionCommands: registerMocks.attention }));
  vi.doMock("../commands/chat/index.js", () => ({ registerChatCommands: registerMocks.chat }));
  vi.doMock("../commands/config/index.js", () => ({ registerConfigCommands: registerMocks.config }));
  vi.doMock("../commands/daemon/index.js", () => ({ registerDaemonCommands: registerMocks.daemon }));
  vi.doMock("../commands/doctor.js", () => ({ registerDoctorCommand: registerMocks.doctor }));
  vi.doMock("../commands/github/index.js", () => ({ registerGithubCommands: registerMocks.github }));
  vi.doMock("../commands/login.js", () => ({ registerLoginCommand: registerMocks.login }));
  vi.doMock("../commands/logout.js", () => ({ registerLogoutCommand: registerMocks.logout }));
  vi.doMock("../commands/org/index.js", () => ({ registerOrgCommands: registerMocks.org }));
  vi.doMock("../commands/status.js", () => ({ registerStatusCommand: registerMocks.status }));
  vi.doMock("../commands/tree/index.js", () => ({ registerTreeCommands: registerMocks.tree }));
  vi.doMock("../commands/upgrade.js", () => ({ registerUpgradeCommand: registerMocks.upgrade }));
  vi.doMock("../core/channel-env.js", () => ({}));
  vi.doMock("../core/channel.js", () => ({ channelConfig: { binName: "first-tree-dev" } }));
  vi.doMock("../core/output.js", () => ({ setJsonMode: setJsonModeMock }));
  vi.doMock("../core/version.js", () => ({ COMMAND_VERSION: "0.0.0-test" }));

  await import("../cli/index.js");
}

describe("CLI entrypoints, chat IO, and attention core helpers", () => {
  const originalStdin = process.stdin;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.FIRST_TREE_LOG_LEVEL;
    commandOptions = {};
    Object.defineProperty(process, "stdin", { configurable: true, value: originalStdin });
  });

  it("wires the executable entrypoint and applies log-level mode precedence", async () => {
    commandOptions = { json: true };
    await importCliEntrypoint();

    expect(setJsonModeMock).toHaveBeenCalledWith(true);
    expect(applyClientLoggerConfigMock).toHaveBeenCalledWith({ level: "error", explicit: true });
    for (const mock of Object.values(registerMocks)) {
      expect(mock).toHaveBeenCalledTimes(1);
    }

    vi.resetModules();
    vi.clearAllMocks();
    commandOptions = { verbose: true };
    await importCliEntrypoint();
    expect(applyClientLoggerConfigMock).toHaveBeenCalledWith({ level: "debug", explicit: true });

    vi.resetModules();
    vi.clearAllMocks();
    commandOptions = {};
    process.env.FIRST_TREE_LOG_LEVEL = "trace";
    await importCliEntrypoint();
    expect(applyClientLoggerConfigMock).toHaveBeenCalledWith({ explicit: true });

    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.FIRST_TREE_LOG_LEVEL;
    await importCliEntrypoint();
    expect(applyClientLoggerConfigMock).toHaveBeenCalledWith({ level: "warn" });
  });

  it("loads the public programmatic API barrel", async () => {
    const api = await import("../index.js");

    expect(api.FirstTreeHubSDK).toBeDefined();
    expect(api.deriveHubUrlFromToken).toBeTypeOf("function");
    expect(api.resolveServerUrl).toBeTypeOf("function");
  }, 15_000);

  it("reads piped stdin, handles TTY stdin, and validates limits", async () => {
    vi.doMock("../cli/output.js", () => ({ fail: failMock }));
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    const { parseLimit, readStdin } = await import("../commands/chat/_shared/io.js");

    const ttyInput = new PassThrough();
    Object.defineProperty(ttyInput, "isTTY", { value: true });
    Object.defineProperty(process, "stdin", { configurable: true, value: ttyInput });
    await expect(readStdin()).resolves.toBeNull();

    const pipedInput = new PassThrough();
    Object.defineProperty(process, "stdin", { configurable: true, value: pipedInput });
    const pending = readStdin();
    pipedInput.write("hello ");
    pipedInput.end("world");
    await expect(pending).resolves.toBe("hello world");

    expect(parseLimit("25", 50)).toBe(25);
    expect(() => parseLimit("0", 50)).toThrow("INVALID_LIMIT:Limit must be between 1 and 50.");
    expect(() => parseLimit("not-a-number", 50)).toThrow("INVALID_LIMIT:Limit must be between 1 and 50.");
  });

  it("passes attention SDK operations through and maps member-scoped respond errors", async () => {
    vi.doMock("../core/bootstrap.js", () => ({
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
      resolveServerUrl: resolveServerUrlMock,
    }));
    vi.doMock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
    const { cancelAttention, listAttentions, raiseAttention, respondAttention, showAttention, AttentionRespondError } =
      await import("../core/attention/index.js");
    const sdk = {
      attention: {
        cancel: cancelMock,
        list: listMock,
        raise: raiseMock,
        show: showMock,
      },
    };
    const attention = {
      id: "attention-1",
      originAgentId: "agent-1",
      originChatId: "chat-1",
      targetHumanId: "human-1",
      subject: "Need approval",
      body: "Please approve",
      requiresResponse: true,
      state: "open",
      response: null,
      respondedBy: null,
      respondedAt: null,
      cancelled: false,
      cancelledReason: null,
      createdAt: "2026-05-28T00:00:00.000Z",
      closedAt: null,
      metadata: {},
    };
    cancelMock.mockResolvedValue(attention);
    listMock.mockResolvedValue([attention]);
    raiseMock.mockResolvedValue(attention);
    showMock.mockResolvedValue(attention);

    await expect(
      Reflect.apply(raiseAttention, undefined, [
        sdk,
        {
          chatId: "chat-1",
          target: "human-1",
          subject: "Need approval",
          body: "Please approve",
          requiresResponse: true,
          metadata: { priority: "high" },
        },
      ]),
    ).resolves.toBe(attention);
    expect(raiseMock).toHaveBeenCalledWith({
      chatId: "chat-1",
      target: "human-1",
      subject: "Need approval",
      body: "Please approve",
      requiresResponse: true,
      metadata: { priority: "high" },
    });
    await expect(Reflect.apply(listAttentions, undefined, [sdk, { state: "all", limit: 10 }])).resolves.toEqual([
      attention,
    ]);
    await expect(Reflect.apply(showAttention, undefined, [sdk, "attention-1"])).resolves.toBe(attention);
    await expect(
      Reflect.apply(cancelAttention, undefined, [sdk, { id: "attention-1", reason: "obsolete" }]),
    ).resolves.toBe(attention);

    ensureFreshAccessTokenMock.mockResolvedValue("access-token");
    resolveServerUrlMock.mockReturnValue("https://hub.example.test");
    cliFetchMock.mockResolvedValueOnce(response(true, 200, attention));
    await expect(respondAttention({ id: "attention/1", text: "Approved" })).resolves.toEqual(attention);
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/attention/attention%2F1/respond",
      expect.objectContaining({
        body: JSON.stringify({ text: "Approved" }),
        method: "POST",
      }),
    );

    cliFetchMock.mockResolvedValueOnce(response(false, 409, JSON.stringify({ error: "already closed" })));
    await expect(respondAttention({ id: "attention-1", answers: { choice: "yes" } })).rejects.toBeInstanceOf(
      AttentionRespondError,
    );

    cliFetchMock.mockResolvedValueOnce(response(false, 500, "plain failure"));
    await expect(respondAttention({ id: "attention-1", answers: {} })).rejects.toMatchObject({
      statusCode: 500,
      message: "plain failure",
    });
  });
});
