import { contextSkillLoaderNameSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { ContextReleaseRootUntrustedError } from "../../core/context-integration/release.js";
import { loadContextSkill } from "../../core/context-integration/skill-loader.js";
import { print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { parseContextProvider } from "./shared.js";

type SkillOptions = {
  protocol?: string;
  provider?: string;
  name?: string;
};

export function configureContextSkillCommand(command: Command): void {
  command
    .argument("<action>", "load")
    .requiredOption("--protocol <version>", "loader protocol version")
    .requiredOption("--provider <provider>", "provider adapter owner")
    .requiredOption("--name <skill>", "canonical Core Skill name");
}

export function runContextSkillLoad(context: CommandContext): void {
  const options = context.command.opts<SkillOptions>();
  if (context.command.args[0] !== "load") {
    print.fail("CONTEXT_SKILL_ACTION_INVALID", "The Context Skill loader supports only the load action.", 2);
  }
  if (options.protocol !== "1") {
    print.fail("CONTEXT_SKILL_LOADER_PROTOCOL_UNSUPPORTED", "Only Context Skill loader protocol 1 is supported.", 2);
  }
  const provider = parseContextProvider(options.provider ?? "");
  const name = contextSkillLoaderNameSchema.safeParse(options.name);
  if (!name.success) {
    print.fail("CONTEXT_SKILL_NAME_INVALID", "The requested Context Skill is not in the Core loader allowlist.", 2);
    throw new Error("unreachable");
  }
  try {
    print.result(
      loadContextSkill({
        schemaVersion: 1,
        loaderProtocolVersion: 1,
        consumerKind: "byo",
        provider,
        name: name.data,
      }),
    );
  } catch (error) {
    if (error instanceof ContextReleaseRootUntrustedError) {
      print.fail(error.code, error.message, 2, {
        nextActions: ["Install or use a version-pinned First Tree CLI release, then retry this task."],
      });
    }
    throw error;
  }
}

export const contextSkillCommand: SubcommandModule = {
  name: "skill",
  hidden: true,
  alias: "",
  summary: "",
  description: "Load a verified canonical Context Skill from the exact CLI release.",
  configure: configureContextSkillCommand,
  action: runContextSkillLoad,
};
