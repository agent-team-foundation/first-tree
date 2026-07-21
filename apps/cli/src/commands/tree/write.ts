import type { Command } from "commander";
import { ContextTreeWritePreflightCliError, preflightContextTreeWrite } from "../../core/context-tree-write.js";
import { isJsonMode, print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type TreeWriteOptions = {
  team?: string;
  snapshot?: string;
  githubLogin?: string;
};

function configureTreeWriteCommand(command: Command): void {
  command
    .option("--team <team-id>", "explicit First Tree Team id for this task")
    .option("--snapshot <directory>", "existing exact task snapshot created by tree read")
    .option("--github-login <login>", "current local gh login for the PR author");
}

export async function runTreeWriteCommand(context: CommandContext): Promise<void> {
  const options = context.command.opts<TreeWriteOptions>();
  let sdk: ReturnType<typeof createMemberSdk> | undefined;

  try {
    const preflight = await preflightContextTreeWrite(
      {
        preflightMemberContextTreeWrite(teamId, request, callOptions): Promise<unknown> {
          sdk ??= createMemberSdk();
          return sdk.preflightMemberContextTreeWrite(teamId, request, callOptions);
        },
      },
      {
        teamId: options.team ?? "",
        snapshotPath: options.snapshot ?? "",
        requesterGithubLogin: options.githubLogin ?? "",
      },
    );

    if (context.options.json || isJsonMode()) {
      print.result(preflight);
      return;
    }

    print.status("Team", preflight.teamId);
    print.status("Binding", `${preflight.binding.repo}#${preflight.binding.branch}`);
    print.status("Exact base", preflight.baseCommit);
    print.status("Snapshot", preflight.snapshotPath);
    print.status("GitHub identity", preflight.requesterGithubLogin);
  } catch (error) {
    if (error instanceof ContextTreeWritePreflightCliError) {
      print.fail(error.code, error.message, error.exitCode, { status: error.stage });
    }
    throw error;
  }
}

export const treeWriteCommand: SubcommandModule = {
  name: "write",
  alias: "",
  summary: "",
  description: "Preflight a clean source-backed Context Tree Write against one exact snapshot.",
  configure: configureTreeWriteCommand,
  action: runTreeWriteCommand,
};
