import type { Command } from "commander";
import { readContextIntegrationInstallJournal } from "../../core/context-integration/installer.js";
import { inspectContextIntegrationOperation } from "../../core/context-integration/operation.js";
import type { ProviderHookProbe } from "../../core/context-integration/provider-driver.js";
import {
  type ContextIntegrationStatus,
  inspectContextIntegrationStatus,
} from "../../core/context-integration/status.js";
import { print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

function configure(command: Command): void {
  command.requiredOption("--provider <provider>", "claude-code or codex");
}

export async function runContextStatus(context: CommandContext): Promise<void> {
  const provider = parseContextProvider(context.command.opts<{ provider?: string }>().provider ?? "");
  const driver = createContextIntegrationDriver(provider);
  const status = await inspectContextIntegrationStatus(driver, createMemberSdk());
  const incompleteInstall = readContextIntegrationInstallJournal();
  const incompleteOperation = inspectContextIntegrationOperation();
  const recovery = [
    ...(incompleteInstall?.provider === provider ? [`Incomplete ${incompleteInstall.phase}; run context repair`] : []),
    ...(incompleteOperation?.provider === provider
      ? [`Incomplete ${incompleteOperation.operation}/${incompleteOperation.phase}; run context repair`]
      : []),
  ];
  const result = { ...status, recovery };
  if (context.options.json) {
    print.result(result);
    return;
  }

  print.status("Provider compatible", renderProvider(status));
  print.status("Plugin installed", status.plugin.installed ? "Yes" : "No");
  print.status("Plugin enabled", status.plugin.installed ? (status.plugin.enabled ? "Yes" : "No") : "Not installed");
  print.status("Plugin payload", status.runtime.healthy ? "Healthy" : "Repair required");
  print.status("Hook trusted", renderHookTrust(status.hook));
  print.status("Hook enabled", renderHookEnabled(status.hook));
  renderCheckout(status);
  renderBinding(status);
  renderActivation(status);
  for (const issue of status.hook.issues) print.status("Hook issue", issue);
  for (const issue of status.runtime.issues) print.status("Issue", issue);
  for (const item of recovery) print.status("Recovery", item);
}

function renderProvider(status: ContextIntegrationStatus): string {
  if (!status.provider.available) return "No — provider executable is missing";
  const version = status.provider.version ?? "unknown version";
  return status.provider.compatible
    ? `Yes — ${version} (requires ${status.provider.minimumVersion}+)`
    : `No — ${version} (requires ${status.provider.minimumVersion}+)`;
}

export function renderHookTrust(hook: ProviderHookProbe): string {
  if (hook.trust === "trusted") return "Yes";
  if (hook.trust === "provider_managed") return "Managed by provider";
  if (hook.trust === "modified") {
    return "No — Hook changed since approval; review First Tree SessionStart in Codex `/hooks`";
  }
  if (hook.trust === "review_required") {
    return "No — review First Tree SessionStart in Codex `/hooks`";
  }
  return hook.source === "unavailable" ? "Not available" : "Unknown";
}

export function renderHookEnabled(hook: ProviderHookProbe): string {
  if (hook.enabled === true) return "Yes";
  if (hook.enabled === false) {
    return hook.source === "provider_managed"
      ? "No — enable the First Tree Context Plugin in Claude Code"
      : "No — enable First Tree SessionStart in Codex `/hooks`";
  }
  if (hook.source === "unavailable") return "Not available";
  return hook.source === "provider_managed" ? "Managed by provider" : "Unknown";
}

function renderCheckout(status: ContextIntegrationStatus): void {
  if (status.checkout.state === "ready") {
    print.status("Checkout", status.checkout.root);
    print.status("Repository", status.checkout.repositoryKey);
    return;
  }
  print.status("Checkout", `Unavailable — ${status.checkout.message}`);
  print.status("Checkout action", status.checkout.nextAction);
}

function renderBinding(status: ContextIntegrationStatus): void {
  if (status.binding.state === "exact") {
    print.status("Exact binding", `Yes — Team ${status.binding.organizationId}`);
    return;
  }
  if (status.binding.state === "missing") {
    print.status("Exact binding", "No");
    print.status("Binding action", status.binding.nextAction);
    return;
  }
  if (status.binding.state === "repository_mismatch") {
    print.status(
      "Exact binding",
      `No — Team ${status.binding.organizationId} is bound to ${status.binding.boundRepositoryKey}`,
    );
    print.status("Binding action", status.binding.nextAction);
    return;
  }
  print.status("Exact binding", `Not checked — ${status.binding.reason}`);
}

function renderActivation(status: ContextIntegrationStatus): void {
  if (status.activation.state === "connected") {
    print.status(
      "Live activation",
      `Connected — ${status.activation.team.displayName} (${status.activation.team.role})`,
    );
    return;
  }
  if (status.activation.state === "disabled" || status.activation.state === "needs_admin") {
    print.status("Live activation", `${status.activation.state} — ${status.activation.message}`);
    if (status.activation.settingsUrl) print.status("Activation action", status.activation.settingsUrl);
    return;
  }
  if (status.activation.state === "unavailable") {
    print.status("Live activation", `Unavailable — ${status.activation.message}`);
    print.status("Activation action", status.activation.nextAction);
    return;
  }
  print.status("Live activation", `Not checked — ${status.activation.reason}`);
}

export const contextStatusCommand: SubcommandModule = {
  name: "status",
  alias: "",
  summary: "",
  description: "Inspect the local Context Plugin, binding, and live Team activation.",
  configure,
  action: runContextStatus,
};
