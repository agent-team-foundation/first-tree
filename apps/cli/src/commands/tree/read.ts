import type { Command } from "commander";
import { activateContextTreeRead, ContextTreeReadActivationError } from "../../core/context-tree-read.js";
import { isJsonMode, print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type TreeReadOptions = {
  team?: string;
  snapshot?: string;
};

function configureTreeReadCommand(command: Command): void {
  command
    .option("--team <team-id>", "explicit First Tree Team id for this task")
    .option("--snapshot <directory>", "new task-owned directory for the exact-commit read snapshot");
}

export async function runTreeReadCommand(context: CommandContext): Promise<void> {
  const options = context.command.opts<TreeReadOptions>();
  let sdk: ReturnType<typeof createMemberSdk> | undefined;

  try {
    const activation = await activateContextTreeRead(
      {
        getMemberContextTreeSetting(teamId: string, options: { retry: false }): Promise<unknown> {
          sdk ??= createMemberSdk();
          return sdk.getMemberContextTreeSetting(teamId, options);
        },
      },
      {
        teamId: options.team ?? "",
        snapshotPath: options.snapshot ?? "",
      },
    );

    if (context.options.json || isJsonMode()) {
      print.result(activation);
      return;
    }

    print.status("Team", activation.teamId);
    print.status("Binding", `${activation.binding.repo}#${activation.binding.branch}`);
    print.status("Exact commit", activation.commit);
    print.status("Snapshot", activation.snapshotPath);
  } catch (error) {
    if (error instanceof ContextTreeReadActivationError) {
      print.fail(error.code, error.message, error.exitCode, { status: error.stage });
    }
    throw error;
  }
}

export const treeReadCommand: SubcommandModule = {
  name: "read",
  alias: "",
  summary: "",
  description: "Activate a strict task-scoped Context Tree read snapshot.",
  configure: configureTreeReadCommand,
  action: runTreeReadCommand,
};
