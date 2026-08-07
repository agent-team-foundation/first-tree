import type { Command } from "commander";
import { AccountStateMutationBusyError } from "../../core/context-integration/account-state-guard.js";
import { inspectContextAdapterNextSessionObligation } from "../../core/context-integration/adapter-observation.js";
import {
  AdapterNextSessionRequiredError,
  AdapterSyncRejectedError,
  hasKnownGoodCompatibleContextAdapter,
  synchronizeContextAdapter,
} from "../../core/context-integration/adapter-sync.js";
import { print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

type Options = { provider?: string; challenge?: string };

function configure(command: Command): void {
  command.requiredOption("--provider <provider>").requiredOption("--challenge <challenge>");
}

export function runContextAdapterSync(context: CommandContext): void {
  const options = context.command.opts<Options>();
  const provider = parseContextProvider(options.provider ?? "");
  const driver = createContextIntegrationDriver(provider);
  try {
    const result = synchronizeContextAdapter(driver, options.challenge ?? "");
    print.result({
      ...result,
      message:
        provider === "claude-code"
          ? "First Tree Context was updated. It will be used in the next Claude session."
          : "First Tree Context was updated. Review /hooks if Codex asks you to trust the updated Hook; otherwise it is guaranteed for the next session.",
    });
  } catch (error) {
    if (
      error instanceof AdapterNextSessionRequiredError ||
      (provider === "claude-code" &&
        (error instanceof AccountStateMutationBusyError || inspectContextAdapterNextSessionObligation() !== null))
    ) {
      print.fail(
        "CONTEXT_PLUGIN_RELOAD_REQUIRED",
        "This Claude session cannot use the repaired First Tree Context Plugin. Start a new Claude session.",
        2,
        { nextActions: ["Start a new Claude session before using persistent First Tree Context."] },
      );
    }
    if (!(error instanceof AdapterSyncRejectedError) && hasKnownGoodCompatibleContextAdapter(driver)) {
      print.result({
        updated: false,
        provider,
        currentAdapterUsable: true,
        status: "update_deferred",
        message: "First Tree Context is still available in this session; its update will be retried later.",
      });
      return;
    }
    if (error instanceof AdapterSyncRejectedError) {
      print.fail(error.code, error.message, 2, {
        nextActions: [`Run an explicit First Tree Context repair for ${provider}, then retry.`],
      });
    }
    throw error;
  }
}

export const contextAdapterSyncCommand: SubcommandModule = {
  name: "adapter-sync",
  hidden: true,
  alias: "",
  summary: "",
  description: "Apply one exact session-bound Context adapter update action.",
  configure,
  action: runContextAdapterSync,
};
