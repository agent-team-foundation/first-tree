import { createHash } from "node:crypto";
import type { Command } from "commander";
import {
  assertContextMutationCanStart,
  withAccountStateMutationLockAsync,
} from "../../core/context-integration/account-state-guard.js";
import { ensureByoContextRepository } from "../../core/context-integration/byo-repository.js";
import { readContextRouteReceipt } from "../../core/context-integration/context-route.js";
import { writeContextWritePlanReceipt } from "../../core/context-integration/write-confirmation.js";
import { readContextTreeReadSnapshotIdentity } from "../../core/context-tree-read.js";
import { ContextTreeWritePreflightCliError, preflightContextTreeWrite } from "../../core/context-tree-write.js";
import { isJsonMode, print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type ContextWriteOptions = { snapshot?: string; githubLogin?: string };

function configure(command: Command): void {
  command
    .requiredOption("--snapshot <directory>", "exact snapshot returned by context snapshot")
    .option("--github-login <login>", "current local gh login for a GitHub PR author");
}

export async function runContextWrite(context: CommandContext): Promise<void> {
  const options = context.command.opts<ContextWriteOptions>();
  try {
    const snapshotIdentity = readContextTreeReadSnapshotIdentity(options.snapshot ?? "");
    if (!snapshotIdentity?.routeCandidateId) {
      print.fail(
        "CONTEXT_TREE_WRITE_ROUTE_REQUIRED",
        "The snapshot does not carry a BYO SCOPE route receipt. Run first-tree-read for this task again.",
        2,
      );
      throw new Error("unreachable");
    }
    const candidate = readContextRouteReceipt(snapshotIdentity.routeCandidateId);
    if (
      candidate.organizationId !== snapshotIdentity.teamId ||
      candidate.commit !== snapshotIdentity.commit ||
      candidate.binding.repo !== snapshotIdentity.binding.repo ||
      candidate.binding.branch !== snapshotIdentity.binding.branch
    ) {
      print.fail(
        "CONTEXT_TREE_WRITE_ROUTE_CHANGED",
        "The selected Team, binding, or exact snapshot no longer matches the task route receipt. Run first-tree-read again.",
        2,
      );
      throw new Error("unreachable");
    }
    const sdk = createMemberSdk();
    const writePlanAnchor = createHash("sha256")
      .update(
        JSON.stringify({
          candidateId: candidate.candidateId,
          teamId: candidate.organizationId,
          binding: candidate.binding,
          commit: candidate.commit,
        }),
      )
      .digest("hex");
    const preflight = await withAccountStateMutationLockAsync(async () => {
      assertContextMutationCanStart();
      const result = await preflightContextTreeWrite(
        {
          preflightMemberContextTreeWrite(teamId, request, callOptions): Promise<unknown> {
            return sdk.preflightMemberContextTreeWrite(teamId, request, callOptions);
          },
        },
        {
          teamId: candidate.organizationId,
          snapshotPath: options.snapshot ?? "",
          ...(options.githubLogin ? { requesterGithubLogin: options.githubLogin } : {}),
        },
        undefined,
        undefined,
        {
          fetchCurrentCommit: (teamId, binding) =>
            ensureByoContextRepository(teamId, binding, candidate.accountClientId).commit,
        },
      );
      writeContextWritePlanReceipt({
        planAnchor: writePlanAnchor,
        candidateId: candidate.candidateId,
        organizationId: candidate.organizationId,
        binding: candidate.binding,
        commit: candidate.commit,
      });
      return result;
    });
    const result = {
      ...preflight,
      consumerKind: "byo" as const,
      selectedTeam: {
        organizationId: candidate.organizationId,
        displayName: candidate.team.displayName,
      },
      routeCandidateId: candidate.candidateId,
      confirmationRequired: true,
      confirmationContract:
        "Show the exact Team, source artifact/revision, target nodes, and proposed mutations. Wait for a new user reply confirming this exact plan before creating an authoring worktree or making any Tree mutation.",
      writePlanAnchor,
    };
    if (context.options.json || isJsonMode()) {
      print.result(result);
      return;
    }
    print.status("Team", `${candidate.team.displayName} (${preflight.teamId})`);
    print.status("Binding", `${preflight.binding.repo}#${preflight.binding.branch}`);
    print.status("Exact base", preflight.baseCommit);
    print.status("Current Reviewer", preflight.reviewerAgentUuid);
    print.status("User confirmation", "Required after the exact write plan is shown");
  } catch (error) {
    if (error instanceof ContextTreeWritePreflightCliError) {
      print.fail(error.code, error.message, error.exitCode, { status: error.stage });
    }
    throw error;
  }
}

export const contextWriteCommand: SubcommandModule = {
  name: "write-preflight",
  hidden: true,
  alias: "",
  summary: "",
  description: "Validate a BYO write against the task's exact SCOPE route receipt.",
  configure,
  action: runContextWrite,
};
