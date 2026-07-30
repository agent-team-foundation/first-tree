import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";
import { readActiveContextAccountClientId } from "../../core/context-integration/account-state-guard.js";
import { buildConnectedContextAdditionalContext } from "../../core/context-integration/activation.js";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import {
  findContextBinding,
  readContextIntegrationConfig,
} from "../../core/context-integration/context-binding-store.js";
import { planContextIntegrationInstall } from "../../core/context-integration/installer.js";
import { enableContextIntegrationOperation } from "../../core/context-integration/operation.js";
import type { ProviderHookProbe } from "../../core/context-integration/provider-driver.js";
import {
  type ContextIntegrationStatus,
  inspectContextIntegrationStatus,
} from "../../core/context-integration/status.js";
import { print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";
import { renderHookEnabled, renderHookTrust } from "./status.js";

type EnableOptions = {
  provider?: string;
  team?: string;
  yes?: boolean;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "claude-code or codex")
    .requiredOption("--team <team-id>", "Team from the server-authored Setup or invite handoff")
    .option("--yes", "accept the displayed local Plugin/binding change plan");
}

export async function runContextEnable(context: CommandContext): Promise<void> {
  const options = context.command.opts<EnableOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const teamId = options.team?.trim() ?? "";
  if (!teamId) {
    print.fail("CONTEXT_TEAM_REQUIRED", "--team must contain the explicit handoff Team id.", 2);
  }
  const expectedAccountClientId = readActiveContextAccountClientId();
  const preflight = inspectContextClientPreflight();
  const sdk = createMemberSdk();
  const activation = await sdk.validateMemberContextActivation(
    teamId,
    {
      schemaVersion: 1,
      repositoryKey: preflight.repositoryKey,
    },
    { retry: false, timeoutMs: 2_000 },
  );
  if (activation.outcome !== "connected") {
    print.fail(
      activation.reasonCode,
      activation.nextAction.message +
        (activation.nextAction.settingsUrl ? ` (${activation.nextAction.settingsUrl})` : ""),
      1,
    );
  }

  const driver = createContextIntegrationDriver(provider);
  const installPlan = planContextIntegrationInstall(driver);
  let expectedConfig: ReturnType<typeof readContextIntegrationConfig>;
  let previousBinding: ReturnType<typeof findContextBinding>;
  try {
    expectedConfig = readContextIntegrationConfig();
    previousBinding = findContextBinding(provider, preflight.checkoutRoot);
  } catch (error) {
    // Fail closed before displaying a plan built on unknown previous
    // bindings; the shared config must never be deleted to recover.
    print.fail(
      "CONTEXT_BINDING_CONFIG_UNREADABLE",
      `${error instanceof Error ? error.message : String(error)} Do not delete the binding config — it also holds bindings for other providers and checkouts. Back it up, then repair its file permissions or YAML together with the member before re-running this command.`,
      1,
    );
    throw error;
  }
  print.status("Provider", provider);
  print.status("Plugin", installPlan.operation);
  print.status("Repository", preflight.repositoryKey);
  print.status("Team binding", previousBinding ? `${previousBinding.organizationId} → ${teamId}` : `add ${teamId}`);

  const accepted =
    options.yes === true ||
    (!context.options.json &&
      (await confirm({
        message: "Apply this user-scope Plugin and exact checkout binding change?",
        default: true,
      })));
  if (!accepted) print.fail("CONTEXT_ENABLE_CANCELLED", "No changes were applied.", 2);

  enableContextIntegrationOperation(
    driver,
    installPlan,
    {
      provider,
      checkoutRoot: preflight.checkoutRoot,
      repositoryKey: preflight.repositoryKey,
      organizationId: teamId,
    },
    expectedConfig,
    expectedAccountClientId,
  );

  const verification = await inspectContextIntegrationStatus(driver, sdk, preflight.checkoutRoot);
  const activationContext =
    verification.activation.state === "connected"
      ? buildConnectedContextAdditionalContext(verification.activation.team)
      : null;
  const missingLayers = collectMissingSetupLayers(provider, verification);
  const setup = { complete: missingLayers.length === 0, missingLayers };
  const nextActions = buildSetupNextActions(provider, verification, setup);
  const result = {
    provider,
    team: activation.team,
    checkoutRoot: preflight.checkoutRoot,
    repositoryKey: preflight.repositoryKey,
    plugin: installPlan.operation,
    verification,
    setup,
    activationContext,
    nextActions,
  };
  if (context.options.json) print.result(result);
  else {
    print.status("Context", `Enabled for ${activation.team.displayName}`);
    print.status("Plugin installed", verification.plugin.installed ? "Yes" : "No");
    print.status("Plugin enabled", verification.plugin.enabled ? "Yes" : "No");
    print.status("Hook trusted", renderHookTrust(verification.hook));
    print.status("Hook enabled", renderHookEnabled(verification.hook));
    print.status(
      "Exact binding",
      verification.binding.state === "exact"
        ? `Yes — Team ${verification.binding.organizationId}`
        : `No — ${verification.binding.state}`,
    );
    print.status(
      "Live activation",
      verification.activation.state === "connected"
        ? `Connected — ${verification.activation.team.displayName}`
        : verification.activation.state,
    );
    print.line(`\n${renderSetupVerdictLine(setup)}\n`);
    if (activationContext) {
      print.line(
        setup.complete
          ? "\nAdopt this Team Context in your current coding-agent session and follow it from now on; future sessions in this repository activate automatically:\n\n"
          : "\nAdopt this Team Context in your current coding-agent session; finish the Next steps below so future sessions activate automatically:\n\n",
      );
      print.line(`${activationContext}\n`);
    }
    nextActions.forEach((action, index) => {
      print.status(`Next ${index + 1}`, action);
    });
  }
}

/**
 * Layered setup verdict: every layer the BYO setup prompt tells the agent to
 * trust must be green before the command reports `Setup: Complete`, including
 * provider compatibility and the installed payload's runtime health — a
 * damaged or mismatched payload must not verify. The hook layers apply only
 * to Codex; Claude Code hooks are provider-managed.
 */
export function collectMissingSetupLayers(
  provider: "claude-code" | "codex",
  verification: Pick<
    ContextIntegrationStatus,
    "provider" | "plugin" | "hook" | "runtime" | "checkout" | "binding" | "activation"
  >,
): string[] {
  return [
    ...(verification.provider.available ? [] : ["Provider available: No"]),
    ...(verification.provider.compatible ? [] : ["Provider compatible: No"]),
    ...(verification.plugin.installed ? [] : ["Plugin installed: No"]),
    ...(verification.plugin.enabled ? [] : ["Plugin enabled: No"]),
    ...(verification.runtime.healthy ? [] : ["Plugin payload healthy: No"]),
    ...(provider === "codex" && verification.hook.trust !== "trusted" ? ["Hook trusted: No"] : []),
    ...(provider === "codex" && verification.hook.enabled !== true ? ["Hook enabled: No"] : []),
    ...(verification.checkout.state === "ready" ? [] : ["Checkout: unavailable"]),
    ...(verification.binding.state === "exact" ? [] : [`Exact binding: ${verification.binding.state}`]),
    ...(verification.activation.state === "connected" ? [] : [`Live activation: ${verification.activation.state}`]),
  ];
}

/**
 * The literal verdict line the BYO setup prompt anchors on: agents accept
 * setup only when the rendered output contains exactly `Setup: Complete`.
 */
export function renderSetupVerdictLine(setup: { complete: boolean; missingLayers: string[] }): string {
  return setup.complete
    ? "Setup: Complete — every layer verified"
    : `Setup: Incomplete — ${setup.missingLayers.join("; ")}`;
}

/**
 * Every red layer must surface an actionable recovery step; the BYO setup
 * prompt delegates all recovery to this command's output, so an Incomplete
 * verdict with no next step is a dead end.
 */
export function collectSetupRecoveryActions(
  provider: "claude-code" | "codex",
  verification: Pick<ContextIntegrationStatus, "provider" | "runtime" | "checkout" | "binding" | "activation">,
  binName = channelConfig.binName,
): string[] {
  const actions: string[] = [];
  if (!verification.provider.available) {
    actions.push(
      `Install the ${provider} CLI (minimum ${verification.provider.minimumVersion}), then re-run this command.`,
    );
  } else if (!verification.provider.compatible) {
    actions.push(`Upgrade ${provider} to at least ${verification.provider.minimumVersion}, then re-run this command.`);
  }
  if (!verification.runtime.healthy) {
    actions.push(
      `${verification.runtime.issues.join(" ")} Run \`${binName} context repair --provider ${provider}\`.`.trimStart(),
    );
  }
  if (verification.checkout.state === "unavailable") {
    actions.push(`${verification.checkout.message} ${verification.checkout.nextAction}`);
  }
  if (verification.binding.state === "missing" || verification.binding.state === "repository_mismatch") {
    actions.push(verification.binding.nextAction);
  } else if (verification.binding.state === "not_checked" && verification.checkout.state === "ready") {
    // A binding-read failure carries its diagnostic (including the config
    // path) only in `reason`; activation `not_checked` is the dependent layer
    // and needs no separate action. The config is one account-scoped store
    // for every provider and checkout, so recovery must stay
    // preservation-safe and never suggest deleting the file.
    actions.push(
      `${verification.binding.reason} Re-run this \`${binName} context enable\` command; if the failure persists, do not delete the binding config — it also holds bindings for other providers and checkouts. Back it up, then repair its file permissions or YAML together with the member before retrying.`,
    );
  }
  if (verification.activation.state === "disabled" || verification.activation.state === "needs_admin") {
    actions.push(
      verification.activation.message +
        (verification.activation.settingsUrl ? ` (${verification.activation.settingsUrl})` : ""),
    );
  } else if (verification.activation.state === "unavailable") {
    actions.push(`${verification.activation.message} ${verification.activation.nextAction}`);
  }
  return actions;
}

/**
 * Assemble the full Next list for an enable run. Guarantees the contract the
 * BYO setup prompt relies on: an Incomplete verdict never ships without at
 * least one next step, even for layer states with no specific recovery
 * (for example `not_checked` binding/activation variants).
 */
export function buildSetupNextActions(
  provider: "claude-code" | "codex",
  verification: Pick<ContextIntegrationStatus, "provider" | "runtime" | "hook" | "checkout" | "binding" | "activation">,
  setup: { complete: boolean; missingLayers: string[] },
  binName = channelConfig.binName,
): string[] {
  const actions = [
    ...collectSetupRecoveryActions(provider, verification, binName),
    ...buildContextEnableNextActions(provider, verification.hook, binName),
  ];
  if (!setup.complete && actions.length === 0) {
    actions.push(`Fix the layers listed in the Setup line, then re-run this \`${binName} context enable\` command.`);
  }
  return actions;
}

export function buildContextEnableNextActions(
  provider: "claude-code" | "codex",
  hook: Pick<ProviderHookProbe, "trust" | "enabled">,
  binName = channelConfig.binName,
): string[] {
  if (provider === "claude-code") {
    return [];
  }
  if (hook.trust === "trusted" && hook.enabled === true) {
    return [`Run \`${binName} context status --provider codex\` to verify every layer remains connected.`];
  }
  if (hook.trust === "trusted" && hook.enabled === false) {
    return [
      "Open Codex in this checkout.",
      "Run `/hooks`.",
      "Find First Tree Context → SessionStart and enable its checkbox.",
      "Exit and start a new Codex session in this checkout.",
      `Re-run the same \`${binName} context enable\` command; setup is complete only when it reports Setup: Complete.`,
    ];
  }
  return [
    "Open Codex in this checkout.",
    "Run `/hooks`.",
    "Find First Tree Context → SessionStart, enable its checkbox, and choose Trust.",
    "Exit and start a new Codex session in this checkout.",
    `Re-run the same \`${binName} context enable\` command; setup is complete only when it reports Setup: Complete.`,
  ];
}

export const contextEnableCommand: SubcommandModule = {
  name: "enable",
  alias: "",
  summary: "",
  description: "Enable First Tree Context for this checkout from an explicit Team handoff.",
  configure,
  action: runContextEnable,
};
