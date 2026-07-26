import type { Command } from "commander";
import { ContextTreeSeedPreflightCliError, preflightContextTreeSeed } from "../../core/context-tree-seed.js";
import { isJsonMode, print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type TreeSeedOptions = {
  team?: string;
};

function configureTreeSeedCommand(command: Command): void {
  command.option("--team <team-id>", "explicit First Tree Team id for this Seed lifecycle");
}

export async function runTreeSeedCommand(context: CommandContext): Promise<void> {
  const options = context.command.opts<TreeSeedOptions>();
  let sdk: ReturnType<typeof createMemberSdk> | undefined;

  try {
    const preflight = await preflightContextTreeSeed(
      {
        preflightMemberContextTreeSeed(teamId, request, callOptions): Promise<unknown> {
          sdk ??= createMemberSdk();
          return sdk.preflightMemberContextTreeSeed(teamId, request, callOptions);
        },
      },
      { teamId: options.team ?? "" },
    );

    if (context.options.json || isJsonMode()) {
      print.result(preflight);
      return;
    }

    print.status("Team", preflight.teamId);
    print.status("Seed authority", "Admin");
    print.status("Context Tree", preflight.state.status === "bound" ? "Bound" : "Unbound");
    if (preflight.state.status === "bound") {
      print.status("Binding", `${preflight.state.binding.repo}#${preflight.state.binding.branch}`);
    } else {
      print.status("Branch", preflight.state.branch);
    }
  } catch (error) {
    if (error instanceof ContextTreeSeedPreflightCliError) {
      print.fail(error.code, error.message, error.exitCode, { status: error.stage });
    }
    throw error;
  }
}

export const treeSeedCommand: SubcommandModule = {
  name: "seed",
  alias: "",
  summary: "",
  description: "Preflight Context Tree Seed authority and binding for one explicit Team.",
  configure: configureTreeSeedCommand,
  action: runTreeSeedCommand,
};
