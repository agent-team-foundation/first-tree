import type { Command } from "commander";
import {
  assertContextMutationCanStart,
  withAccountStateMutationLockAsync,
} from "../../core/context-integration/account-state-guard.js";
import {
  createByoContextWriteWorktree,
  ensureByoContextRepository,
  finishByoContextWriteWorktree,
  inspectByoContextWriteWorktree,
} from "../../core/context-integration/byo-repository.js";
import { readContextRouteReceipt } from "../../core/context-integration/context-route.js";
import {
  consumeContextWritePlanReceipt,
  readContextWritePlanReceipt,
} from "../../core/context-integration/write-confirmation.js";
import { readContextTreeReadSnapshotIdentity } from "../../core/context-tree-read.js";
import { preflightContextTreeWrite } from "../../core/context-tree-write.js";
import { print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type StartOptions = { snapshot?: string; planAnchor?: string; confirmed?: boolean; githubLogin?: string };
type FinishOptions = { team?: string; operation?: string };
type StatusOptions = { team?: string; planAnchor?: string };

function configureStart(command: Command): void {
  command
    .requiredOption("--snapshot <directory>", "exact routed snapshot")
    .requiredOption("--plan-anchor <digest>", "write plan anchor returned by live preflight")
    .requiredOption("--confirmed", "assert that the user confirmed the exact displayed write plan")
    .option("--github-login <login>", "current local gh login for a GitHub PR author");
}

export async function runContextWriteWorktree(context: CommandContext): Promise<void> {
  const options = context.command.opts<StartOptions>();
  if (options.confirmed !== true) {
    print.fail("CONTEXT_TREE_WRITE_CONFIRMATION_REQUIRED", "The exact write plan requires a new user confirmation.", 2);
  }
  const snapshot = readContextTreeReadSnapshotIdentity(options.snapshot ?? "");
  if (!snapshot?.routeCandidateId) {
    print.fail("CONTEXT_TREE_WRITE_ROUTE_REQUIRED", "The exact snapshot no longer carries its route receipt.", 2);
    throw new Error("unreachable");
  }
  const candidate = readContextRouteReceipt(snapshot.routeCandidateId);
  const sdk = createMemberSdk();
  const result = await withAccountStateMutationLockAsync(async () => {
    assertContextMutationCanStart();
    const planAnchor = options.planAnchor ?? "";
    const existing = inspectByoContextWriteWorktree(candidate.organizationId, planAnchor);
    if (existing) {
      assertExistingWriteMatches(existing, candidate.candidateId, snapshot);
      return renderWriteResult(existing);
    }
    const receipt = readContextWritePlanReceipt(candidate.organizationId, planAnchor);
    if (
      receipt.candidateId !== candidate.candidateId ||
      receipt.commit !== snapshot.commit ||
      receipt.binding.repo !== snapshot.binding.repo ||
      receipt.binding.branch !== snapshot.binding.branch
    ) {
      print.fail("CONTEXT_TREE_WRITE_PLAN_CHANGED", "The routed Team, binding, or base changed after confirmation.", 2);
    }
    const preflight = await preflightContextTreeWrite(
      {
        preflightMemberContextTreeWrite(teamId, request, callOptions): Promise<unknown> {
          return sdk.preflightMemberContextTreeWrite(teamId, request, callOptions);
        },
      },
      {
        teamId: candidate.organizationId,
        snapshotPath: snapshot.snapshotPath,
        ...(options.githubLogin ? { requesterGithubLogin: options.githubLogin } : {}),
      },
      undefined,
      undefined,
      {
        fetchCurrentCommit: (teamId, binding) =>
          ensureByoContextRepository(teamId, binding, candidate.accountClientId).commit,
      },
    );
    const worktree = createByoContextWriteWorktree({
      organizationId: candidate.organizationId,
      binding: preflight.binding,
      baseCommit: preflight.baseCommit,
      planAnchor: receipt.planAnchor,
      candidateId: candidate.candidateId,
      expectedAccountClientId: candidate.accountClientId,
    });
    consumeContextWritePlanReceipt(candidate.organizationId, receipt.planAnchor);
    return renderWriteResult(worktree);
  });
  print.result(result);
}

function configureStatus(command: Command): void {
  command
    .requiredOption("--team <team-id>", "Team owning the BYO authoring worktree")
    .requiredOption("--plan-anchor <digest>", "exact confirmed write plan anchor");
}

export async function runContextWriteStatus(context: CommandContext): Promise<void> {
  const options = context.command.opts<StatusOptions>();
  const result = await withAccountStateMutationLockAsync(async () => {
    assertContextMutationCanStart();
    return inspectByoContextWriteWorktree(options.team ?? "", options.planAnchor ?? "");
  });
  print.result(result ? renderWriteResult(result) : { schemaVersion: 1, active: false });
}

function renderWriteResult(worktree: {
  organizationId: string;
  operationId: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}) {
  return {
    schemaVersion: 1,
    consumerKind: "byo" as const,
    active: true,
    organizationId: worktree.organizationId,
    operationId: worktree.operationId,
    worktreePath: worktree.worktreePath,
    branch: worktree.branch,
    baseCommit: worktree.baseCommit,
  };
}

function assertExistingWriteMatches(
  worktree: { candidateId: string; baseCommit: string; repository: string; bindingBranch: string },
  candidateId: string,
  snapshot: { commit: string; binding: { repo: string; branch: string } },
): void {
  if (
    worktree.candidateId !== candidateId ||
    worktree.baseCommit !== snapshot.commit ||
    worktree.repository !== snapshot.binding.repo ||
    worktree.bindingBranch !== snapshot.binding.branch
  ) {
    throw new Error("The durable BYO write result does not match this routed snapshot.");
  }
}

function configureFinish(command: Command): void {
  command
    .requiredOption("--team <team-id>", "Team owning the BYO authoring worktree")
    .requiredOption("--operation <operation-id>", "write operation returned by write-worktree");
}

export async function runContextWriteFinish(context: CommandContext): Promise<void> {
  const options = context.command.opts<FinishOptions>();
  await withAccountStateMutationLockAsync(async () => {
    assertContextMutationCanStart();
    finishByoContextWriteWorktree(options.team ?? "", options.operation ?? "");
  });
  print.result({ schemaVersion: 1, complete: true, operationId: options.operation });
}

export const contextWriteWorktreeCommand: SubcommandModule = {
  name: "write-worktree",
  hidden: true,
  alias: "",
  summary: "",
  description: "Create an exclusive BYO Tree authoring worktree after exact-plan confirmation.",
  configure: configureStart,
  action: runContextWriteWorktree,
};

export const contextWriteFinishCommand: SubcommandModule = {
  name: "write-finish",
  hidden: true,
  alias: "",
  summary: "",
  description: "Release a completed BYO Tree authoring worktree.",
  configure: configureFinish,
  action: runContextWriteFinish,
};

export const contextWriteStatusCommand: SubcommandModule = {
  name: "write-status",
  hidden: true,
  alias: "",
  summary: "",
  description: "Recover or inspect one exact BYO Tree authoring result.",
  configure: configureStatus,
  action: runContextWriteStatus,
};
