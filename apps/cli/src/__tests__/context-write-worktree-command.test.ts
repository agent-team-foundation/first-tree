import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const mocks = vi.hoisted(() => ({
  result: vi.fn(),
  fail: vi.fn((code: string, message: string) => {
    throw Object.assign(new Error(message), { code });
  }),
  inspect: vi.fn(),
  create: vi.fn(),
  finish: vi.fn(),
  ensure: vi.fn(),
  readRoute: vi.fn(),
  readPlan: vi.fn(),
  consumePlan: vi.fn(),
  readSnapshot: vi.fn(),
  preflight: vi.fn(),
}));

vi.mock("../core/output.js", () => ({ print: { result: mocks.result, fail: mocks.fail } }));
vi.mock("../core/context-integration/account-state-guard.js", () => ({
  assertContextMutationCanStart: () => undefined,
  withAccountStateMutationLockAsync: (action: () => Promise<unknown>) => action(),
}));
vi.mock("../core/context-integration/adapter-observation.js", () => ({
  assertContextAdapterReadyForRouting: () => undefined,
}));
vi.mock("../core/context-integration/byo-repository.js", () => ({
  createByoContextWriteWorktree: mocks.create,
  ensureByoContextRepository: mocks.ensure,
  finishByoContextWriteWorktree: mocks.finish,
  inspectByoContextWriteWorktree: mocks.inspect,
}));
vi.mock("../core/context-integration/context-route.js", () => ({ readContextRouteReceipt: mocks.readRoute }));
vi.mock("../core/context-integration/write-confirmation.js", () => ({
  readContextWritePlanReceipt: mocks.readPlan,
  consumeContextWritePlanReceipt: mocks.consumePlan,
}));
vi.mock("../core/context-tree-read.js", () => ({
  readContextTreeReadSnapshotIdentity: mocks.readSnapshot,
}));
vi.mock("../core/context-tree-write.js", () => ({ preflightContextTreeWrite: mocks.preflight }));
vi.mock("../commands/_shared/member.js", () => ({ createMemberSdk: () => ({}) }));

import {
  runContextWriteFinish,
  runContextWriteStatus,
  runContextWriteWorktree,
} from "../commands/context/write-worktree.js";

const planAnchor = "a".repeat(64);
const baseCommit = "b".repeat(40);
const binding = { repo: "https://github.com/acme/context-tree", branch: "main" };
const active = {
  organizationId: "org-acme",
  operationId: `write-${planAnchor}`,
  worktreePath: `/tmp/worktree-${planAnchor}`,
  branch: `first-tree/context-write-${planAnchor}`,
  baseCommit,
  planAnchor,
  candidateId: "candidate-a",
  repository: binding.repo,
  bindingBranch: binding.branch,
  phase: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSnapshot.mockReturnValue({
    routeCandidateId: "candidate-a",
    snapshotPath: "/tmp/snapshot",
    teamId: "org-acme",
    commit: baseCommit,
    binding,
  });
  mocks.readRoute.mockReturnValue({
    candidateId: "candidate-a",
    accountClientId: "client_1234abcd",
    organizationId: "org-acme",
    provider: "codex",
    source: "session",
  });
  mocks.readPlan.mockReturnValue({ candidateId: "candidate-a", commit: baseCommit, binding, planAnchor });
  mocks.preflight.mockResolvedValue({ binding, baseCommit });
  mocks.create.mockReturnValue(active);
  mocks.ensure.mockReturnValue({ commit: baseCommit });
});

describe("context write-worktree recovery", () => {
  it("returns the same durable operation after result output is lost and the plan receipt was consumed", async () => {
    mocks.inspect.mockReturnValueOnce(null).mockReturnValueOnce(active);
    mocks.result.mockImplementationOnce(() => {
      throw new Error("stdout lost");
    });

    await expect(runContextWriteWorktree(startContext())).rejects.toThrow("stdout lost");
    await expect(runContextWriteWorktree(startContext())).resolves.toBeUndefined();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.readPlan).toHaveBeenCalledTimes(1);
    expect(mocks.consumePlan).toHaveBeenCalledTimes(1);
    expect(mocks.result.mock.calls[1]?.[0]).toMatchObject({ operationId: active.operationId, active: true });
  });

  it("exposes the durable result by exact plan anchor and keeps finish retryable", async () => {
    mocks.inspect.mockReturnValue(active);
    await runContextWriteStatus(context({ team: "org-acme", planAnchor }));
    await runContextWriteFinish(context({ team: "org-acme", operation: active.operationId }));
    await runContextWriteFinish(context({ team: "org-acme", operation: active.operationId }));

    expect(mocks.result.mock.calls[0]?.[0]).toMatchObject({ operationId: active.operationId, active: true });
    expect(mocks.finish).toHaveBeenCalledTimes(2);
  });
});

function startContext(): CommandContext {
  return context({ snapshot: "/tmp/snapshot", planAnchor, confirmed: true });
}

function context(options: Record<string, unknown>): CommandContext {
  return {
    command: { opts: () => options } as unknown as Command,
    options: { json: true, debug: false, quiet: false },
  };
}
