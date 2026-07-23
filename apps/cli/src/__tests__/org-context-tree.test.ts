import { SdkError } from "@first-tree/client";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOrgContextTreeCommand } from "../commands/org/context-tree.js";
import { setJsonMode } from "../core/output.js";

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

const memberMocks = vi.hoisted(() => ({
  createMemberSdk: vi.fn(),
}));

vi.mock("../commands/_shared/local-agent.js", () => ({
  createSdk: localAgentMocks.createSdk,
  handleSdkError: localAgentMocks.handleSdkError,
}));
vi.mock("../commands/_shared/member.js", () => memberMocks);

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

function buildProgram(): Command {
  const program = new Command();
  registerOrgContextTreeCommand(program);
  return program;
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
});

describe("org context-tree CLI", () => {
  it("prints the live Reviewer assignment and binding without mode fields", async () => {
    const sdk = {
      agentId: "reviewer-1",
      getAgentContextReviewConfig: vi.fn(async () => ({
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
        contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
      })),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await buildProgram().parseAsync(["context-tree", "review-config", "--agent", "reviewer"], { from: "user" });

    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("reviewer");
    expect(stderr).toContain("Context Review       Assigned");
    expect(stderr).toContain("Repository           https://github.com/acme/context-tree.git");
    expect(successEnvelope()).toEqual({
      ok: true,
      data: {
        provider: "github",
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
        enabled: true,
        assigned: true,
        agentUuid: "reviewer-1",
      },
    });
  });

  it("reads Reviewer configuration as the signed-in member without a running Client Runtime or local Agent", async () => {
    memberMocks.createMemberSdk.mockReturnValue({
      getMemberProfile: vi.fn(async () => ({
        memberships: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
        defaultOrganizationId: "org-b",
      })),
      getMemberContextTreeSetting: vi.fn(async () => ({
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
      })),
      getMemberContextTreeFeatures: vi.fn(async () => ({
        contextReviewer: {
          enabled: true,
          agentUuid: "private-reviewer",
          reviewerAgent: { uuid: "private-reviewer", name: null, displayName: "Reviewer" },
        },
      })),
    });

    await buildProgram().parseAsync(["context-tree", "review-config", "--as-member"], { from: "user" });

    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
    expect(stderr).toContain("Reviewer             private-reviewer");
    expect(successEnvelope()).toMatchObject({
      ok: true,
      data: { enabled: true, assigned: true, agentUuid: "private-reviewer" },
    });
  });

  it("reads and renders a bound agent-scoped binding with the default branch", async () => {
    const sdk = {
      agentId: "agent-1",
      getAgentContextTreeConfig: vi.fn(async () => ({
        repo: "git@github.com:acme/context-tree.git",
        branch: null,
      })),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await buildProgram().parseAsync(["context-tree", "--agent", "writer"], { from: "user" });

    expect(localAgentMocks.createSdk).toHaveBeenCalledTimes(1);
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("writer");
    expect(sdk.getAgentContextTreeConfig).toHaveBeenCalledTimes(1);
    expect(stderr).toContain("Context Tree         Bound");
    expect(stderr).toContain("Repository           git@github.com:acme/context-tree.git");
    expect(stderr).toContain("Branch               main");
    expect(successEnvelope()).toEqual({
      ok: true,
      data: {
        status: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: "main",
      },
    });
  });

  it("normalizes an unbound response and prints the administrator action", async () => {
    const sdk = {
      agentId: "agent-1",
      getAgentContextTreeConfig: vi.fn(async () => ({ repo: null, branch: "main" })),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await buildProgram().parseAsync(["context-tree"], { from: "user" });

    expect(localAgentMocks.createSdk).toHaveBeenCalledWith(undefined);
    expect(stderr).toContain("Context Tree         Unbound");
    expect(stderr).toContain("Ask an administrator for this agent's organization");
    expect(successEnvelope()).toEqual({
      ok: true,
      data: { status: "unbound", repo: null, branch: null },
    });
  });

  it("silences human output in JSON mode while preserving the exact success envelope", async () => {
    setJsonMode(true);
    localAgentMocks.createSdk.mockReturnValue({
      agentId: "agent-1",
      getAgentContextTreeConfig: vi.fn(async () => ({
        repo: "https://github.com/acme/context-tree.git",
        branch: "release",
      })),
    });

    await buildProgram().parseAsync(["context-tree"], { from: "user" });

    expect(stderr).toBe("");
    expect(successEnvelope()).toEqual({
      ok: true,
      data: {
        status: "bound",
        repo: "https://github.com/acme/context-tree.git",
        branch: "release",
      },
    });
  });

  it.each([
    {
      label: "authentication",
      error: new SdkError(401, "secret-response-body"),
      expectedExitCode: 3,
    },
    {
      label: "timeout",
      error: Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
      expectedExitCode: 6,
    },
  ])("reports $label failures as unreadable", async ({ error, expectedExitCode }) => {
    localAgentMocks.createSdk.mockReturnValue({
      agentId: "agent-1",
      getAgentContextTreeConfig: vi.fn(async () => {
        throw error;
      }),
    });
    process.exit = ((code?: string | number | null): never => {
      throw new ProcessExit(Number(code ?? 0));
    }) as typeof process.exit;

    await expect(buildProgram().parseAsync(["context-tree"], { from: "user" })).rejects.toMatchObject({
      exitCode: expectedExitCode,
    });

    expect(stderr).toContain("Context Tree         Unreadable");
    expect(errorEnvelope()).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_TREE_UNREADABLE", status: "unreadable" },
    });
    expect(stderr).not.toContain("secret-response-body");
    expect(stdout).toBe("");
  });

  it("keeps local agent resolution failures outside the unreadable boundary", async () => {
    const selectionError = Object.assign(new Error("choose an agent"), {
      code: "AMBIGUOUS_AGENT",
      exitCode: 2,
    });
    localAgentMocks.createSdk.mockImplementation(() => {
      throw selectionError;
    });

    await expect(buildProgram().parseAsync(["context-tree"], { from: "user" })).rejects.toBe(selectionError);

    expect(stderr).not.toContain("Unreadable");
    expect(stderr).not.toContain("CONTEXT_TREE_UNREADABLE");
    expect(stdout).toBe("");
  });
});
