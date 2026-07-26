import { SdkError } from "@first-tree/client";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOrgContextTreeCommand } from "../commands/org/context-tree.js";
import { setJsonMode } from "../core/output.js";

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
}));

vi.mock("../commands/_shared/local-agent.js", () => ({
  createSdk: localAgentMocks.createSdk,
}));

const REPO = "git@github.com:acme/context-tree.git";

class ProcessExit extends Error {
  constructor(readonly exitCode: number) {
    super(`process.exit(${exitCode})`);
  }
}

let stdout = "";
let stderr = "";
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let originalExit: typeof process.exit;
const originalFirstTreeJson = process.env.FIRST_TREE_JSON;

function buildProgram(): Command {
  const program = new Command();
  program.option("--json");
  program.hook("preAction", (command) => {
    const options = command.optsWithGlobals<{ json?: boolean }>();
    setJsonMode(options.json === true || process.env.FIRST_TREE_JSON === "1");
  });
  registerOrgContextTreeCommand(program);
  return program;
}

function parseSet(args: string[]): Promise<Command> {
  return buildProgram().parseAsync(["context-tree", "set", ...args], { from: "user" });
}

function successEnvelope(): unknown {
  return JSON.parse(stdout.trim());
}

function errorEnvelope(): unknown {
  const line = stderr
    .trim()
    .split("\n")
    .find((entry) => entry.startsWith('{"ok":false'));
  return JSON.parse(line ?? "{}");
}

beforeEach(() => {
  vi.clearAllMocks();
  setJsonMode(false);
  delete process.env.FIRST_TREE_JSON;
  stdout = "";
  stderr = "";

  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  originalExit = process.exit;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  setJsonMode(false);
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exit = originalExit;
  if (originalFirstTreeJson === undefined) delete process.env.FIRST_TREE_JSON;
  else process.env.FIRST_TREE_JSON = originalFirstTreeJson;
});

describe("org context-tree set CLI", () => {
  it("renders a successful direct binding replacement with the final branch", async () => {
    const setAgentContextTreeConfig = vi.fn(async () => ({ repo: REPO, branch: "release" }));
    localAgentMocks.createSdk.mockReturnValue({ agentId: "agent-1", setAgentContextTreeConfig });

    await parseSet([REPO, "--branch", "release", "--agent", "writer"]);

    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("writer");
    expect(setAgentContextTreeConfig).toHaveBeenCalledWith({ repo: REPO, branch: "release" });
    expect(stderr).toContain("Context Tree         Bound");
    expect(stderr).toContain(`Repository           ${REPO}`);
    expect(stderr).toContain("Branch               release");
    expect(successEnvelope()).toEqual({
      ok: true,
      data: { status: "bound", repo: REPO, branch: "release" },
    });
  });

  it.each([
    ["global option", ["--json", "context-tree", "set", REPO]],
    ["environment", ["context-tree", "set", REPO]],
  ])("silences human output in JSON mode selected by the $label", async (label, argv) => {
    if (label === "environment") process.env.FIRST_TREE_JSON = "1";
    localAgentMocks.createSdk.mockReturnValue({
      agentId: "agent-1",
      setAgentContextTreeConfig: vi.fn(async () => ({ repo: REPO, branch: "main" })),
    });

    await buildProgram().parseAsync(argv, { from: "user" });

    expect(stderr).toBe("");
    expect(successEnvelope()).toEqual({
      ok: true,
      data: { status: "bound", repo: REPO, branch: "main" },
    });
  });

  it.each([
    ["global option", ["--json", "context-tree", "set", REPO]],
    ["environment", ["context-tree", "set", REPO]],
  ])("emits only the exact failure envelope in JSON mode selected by the $label", async (label, argv) => {
    if (label === "environment") process.env.FIRST_TREE_JSON = "1";
    localAgentMocks.createSdk.mockReturnValue({
      agentId: "agent-1",
      setAgentContextTreeConfig: vi.fn(async () => {
        throw new SdkError(403, "private-forbidden-body");
      }),
    });
    process.exit = ((code?: string | number | null): never => {
      throw new ProcessExit(Number(code ?? 0));
    }) as typeof process.exit;

    await expect(buildProgram().parseAsync(argv, { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(stdout).toBe("");
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stderr.trim())).toEqual({
      ok: false,
      error: {
        code: "CONTEXT_TREE_UPDATE_FAILED",
        message:
          "The server rejected the Context Tree binding update (HTTP 403). Administrator access to the selected agent's organization is required.",
      },
    });
  });

  it.each([
    ["repository", ["http://github.com/acme/context-tree.git"], "INVALID_CONTEXT_TREE_REPO"],
    ["branch", [REPO, "--branch", " main"], "INVALID_CONTEXT_TREE_BRANCH"],
    ["Git-invalid branch", [REPO, "--branch", "feature..next"], "INVALID_CONTEXT_TREE_BRANCH"],
  ])("rejects invalid $label input before creating the SDK", async (_label, args, code) => {
    process.exit = ((exitCode?: string | number | null): never => {
      throw new ProcessExit(Number(exitCode ?? 0));
    }) as typeof process.exit;

    await expect(parseSet(args)).rejects.toMatchObject({ exitCode: 2 });

    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
    expect(errorEnvelope()).toEqual({
      ok: false,
      error: { code, message: expect.any(String) },
    });
    expect(stdout).toBe("");
  });

  it.each([
    ["authentication", new SdkError(401, "private-auth-body"), 3],
    ["forbidden", new SdkError(403, "private-forbidden-body"), 1],
    ["server failure", new SdkError(503, "private-server-body"), 1],
    [
      "connection",
      new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "ECONNREFUSED" }) }),
      6,
    ],
    ["timeout", new DOMException("request timed out", "TimeoutError"), 6],
    ["invalid JSON", new SyntaxError("private-invalid-response"), 1],
  ])("emits the sanitized update envelope for $label failures", async (_label, error, exitCode) => {
    localAgentMocks.createSdk.mockReturnValue({
      agentId: "agent-1",
      setAgentContextTreeConfig: vi.fn(async () => {
        throw error;
      }),
    });
    process.exit = ((code?: string | number | null): never => {
      throw new ProcessExit(Number(code ?? 0));
    }) as typeof process.exit;

    await expect(parseSet([REPO])).rejects.toMatchObject({ exitCode });

    expect(errorEnvelope()).toEqual({
      ok: false,
      error: { code: "CONTEXT_TREE_UPDATE_FAILED", message: expect.any(String) },
    });
    expect(stderr).toContain("Context Tree         Update failed");
    expect(stderr).not.toContain(error.message);
    expect(stderr).not.toContain("Bound");
    expect(stdout).toBe("");
  });

  it("treats an inconsistent success response as an update failure", async () => {
    localAgentMocks.createSdk.mockReturnValue({
      agentId: "agent-1",
      setAgentContextTreeConfig: vi.fn(async () => ({ repo: "git@github.com:acme/other.git", branch: "main" })),
    });
    process.exit = ((code?: string | number | null): never => {
      throw new ProcessExit(Number(code ?? 0));
    }) as typeof process.exit;

    await expect(parseSet([REPO])).rejects.toMatchObject({ exitCode: 1 });

    expect(errorEnvelope()).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TREE_UPDATE_FAILED" },
    });
    expect(stderr).not.toContain("Bound");
    expect(stdout).toBe("");
  });

  it("keeps local agent selection errors outside the update failure boundary", async () => {
    const selectionError = Object.assign(new Error("choose an agent"), {
      code: "AMBIGUOUS_AGENT",
      exitCode: 2,
    });
    localAgentMocks.createSdk.mockImplementation(() => {
      throw selectionError;
    });

    await expect(parseSet([REPO])).rejects.toBe(selectionError);

    expect(stderr).not.toContain("CONTEXT_TREE_UPDATE_FAILED");
    expect(stdout).toBe("");
  });
});
