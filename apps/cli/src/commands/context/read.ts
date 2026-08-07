import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import {
  assertContextMutationCanStart,
  withAccountStateMutationLockAsync,
} from "../../core/context-integration/account-state-guard.js";
import { buildByoContextAdditionalContext } from "../../core/context-integration/activation.js";
import { ensureByoContextRepository } from "../../core/context-integration/byo-repository.js";
import { readContextRouteReceipt } from "../../core/context-integration/context-route.js";
import { activateContextTreeRead, ContextTreeReadActivationError } from "../../core/context-tree-read.js";
import { isJsonMode, print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type ContextReadOptions = { candidate?: string };

function configure(command: Command): void {
  command.requiredOption("--candidate <candidate-id>", "opaque candidate id returned by context route");
}

export async function runContextRead(context: CommandContext): Promise<void> {
  const options = context.command.opts<ContextReadOptions>();
  try {
    const candidate = readContextRouteReceipt(options.candidate ?? "");
    const sdk = createMemberSdk();
    const snapshotPath = join(mkdtempSync(join(tmpdir(), "first-tree-read-")), "context-tree");
    const snapshot = await withAccountStateMutationLockAsync(async () => {
      assertContextMutationCanStart();
      return activateContextTreeRead(
        {
          getMemberContextTreeSetting(teamId, callOptions): Promise<unknown> {
            return sdk.getMemberContextTreeSetting(teamId, callOptions);
          },
        },
        {
          teamId: candidate.organizationId,
          snapshotPath,
          expectedBinding: candidate.binding,
          expectedCommit: candidate.commit,
          routeCandidateId: candidate.candidateId,
        },
        undefined,
        {
          prepareRepository: (teamId, binding) =>
            ensureByoContextRepository(teamId, binding, candidate.accountClientId),
        },
      );
    });
    const result = {
      ...snapshot,
      consumerKind: "byo" as const,
      selectedTeam: {
        organizationId: candidate.organizationId,
        displayName: candidate.team.displayName,
        role: candidate.team.role,
      },
      routeSelection: {
        candidateId: candidate.candidateId,
        scopeCommit: candidate.commit,
        source: candidate.source,
      },
      activationProject: {
        provider: candidate.provider,
        project: candidate.project,
        selectorArgs:
          candidate.project.kind === "path"
            ? (["--project-root", candidate.project.root] as const)
            : (["--pathless"] as const),
      },
      activationContext: buildByoContextAdditionalContext(),
    };
    if (context.options.json || isJsonMode()) {
      print.result(result);
      return;
    }
    print.status("Team", `${candidate.team.displayName} (${candidate.organizationId})`);
    print.status("Provider", snapshot.binding.provider ?? "legacy/unresolved");
    print.status("Binding", `${snapshot.binding.repo}#${snapshot.binding.branch}`);
    print.status("Exact commit", snapshot.commit);
    print.status("Snapshot", snapshot.snapshotPath);
  } catch (error) {
    if (error instanceof ContextTreeReadActivationError) {
      print.fail(error.code, error.message, error.exitCode, { status: error.stage });
    }
    throw error;
  }
}

export const contextReadCommand: SubcommandModule = {
  name: "snapshot",
  hidden: true,
  alias: "",
  summary: "",
  description: "Materialize the exact Tree snapshot selected by a SCOPE route receipt.",
  configure,
  action: runContextRead,
};
