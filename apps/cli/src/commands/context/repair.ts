import type { Command } from "commander";
import {
  assertContextMutationCanStart,
  withAccountStateMutationLock,
} from "../../core/context-integration/account-state-guard.js";
import { inspectContextAdapterNextSessionObligation } from "../../core/context-integration/adapter-observation.js";
import { planContextIntegrationInstall } from "../../core/context-integration/installer.js";
import { readContextIntegrationInstallManifest } from "../../core/context-integration/manifest.js";
import {
  recoverContextIntegrationOperation,
  repairContextIntegrationOperation,
} from "../../core/context-integration/operation.js";
import { print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

function configure(command: Command): void {
  command.requiredOption("--provider <provider>", "claude-code or codex");
}

export function runContextRepair(context: CommandContext): void {
  const provider = parseContextProvider(context.command.opts<{ provider?: string }>().provider ?? "");
  const driver = createContextIntegrationDriver(provider);
  const result = withAccountStateMutationLock(() => {
    assertContextMutationCanStart();
    const recoveredOperation = recoverContextIntegrationOperation(driver);
    const plan = planContextIntegrationInstall(driver);
    if (plan.operation !== "unchanged") {
      repairContextIntegrationOperation(driver, plan, {
        nextSessionObligationKind: provider === "claude-code" ? "standalone_repair" : undefined,
      });
    }
    const nextSessionObligation = provider === "claude-code" ? inspectContextAdapterNextSessionObligation() : null;
    return {
      manifest: readContextIntegrationInstallManifest(provider),
      probe: driver.probe(plan.marketplaceName, "first-tree-context"),
      repaired: recoveredOperation || plan.operation !== "unchanged",
      nextSessionPending: nextSessionObligation !== null,
      nextActions: nextSessionObligation ? ["Start a new Claude session to use the repaired Context Plugin."] : [],
    };
  });
  if (context.options.json) print.result(result);
  else {
    print.status("Context Plugin", result.repaired ? "Repaired" : "Healthy");
    result.nextActions.forEach((action, index) => {
      print.status(`Next ${index + 1}`, action);
    });
  }
}

export const contextRepairCommand: SubcommandModule = {
  name: "repair",
  alias: "",
  summary: "",
  description: "Repair the First Tree user-scope Context Plugin.",
  configure,
  action: runContextRepair,
};
