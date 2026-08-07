import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";
import { inspectContextAdapterNextSessionObligation } from "../../core/context-integration/adapter-observation.js";
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
  command
    .requiredOption("--provider <provider>", "claude-code or codex")
    .option("--project-root <directory>", "attached provider project root")
    .option("--pathless", "inspect applicable grants for a pathless provider project");
}

export async function runContextStatus(context: CommandContext): Promise<void> {
  const options = context.command.opts<{ provider?: string; projectRoot?: string; pathless?: boolean }>();
  const provider = parseContextProvider(options.provider ?? "");
  const driver = createContextIntegrationDriver(provider);
  const status = await inspectContextIntegrationStatus(driver, createMemberSdk(), {
    projectRoot: options.projectRoot,
    pathless: options.pathless,
  });
  const incompleteInstall = readContextIntegrationInstallJournal();
  const incompleteOperation = inspectContextIntegrationOperation();
  const nextSessionObligation = provider === "claude-code" ? inspectContextAdapterNextSessionObligation() : null;
  const recovery = [
    ...(incompleteInstall?.provider === provider
      ? [`Incomplete ${incompleteInstall.phase}; run ${channelConfig.binName} context repair --provider ${provider}`]
      : []),
    ...(incompleteOperation?.provider === provider
      ? [
          `Incomplete ${incompleteOperation.operation}/${incompleteOperation.phase}; run ${channelConfig.binName} context repair --provider ${provider}`,
        ]
      : []),
    ...(nextSessionObligation === "standalone_repair"
      ? ["Start a new Claude session to adopt the repaired Context Plugin"]
      : nextSessionObligation === "setup"
        ? ["Start a new Claude session for persistent Context auto-activation"]
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
  renderProject(status);
  renderGrants(status);
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

function renderProject(status: ContextIntegrationStatus): void {
  if (status.project.state === "ready") {
    print.status("Project", status.project.project.kind === "path" ? status.project.project.root : "Pathless");
    return;
  }
  print.status("Project", `Unavailable — ${status.project.message}`);
  print.status("Project action", status.project.nextAction);
}

function renderGrants(status: ContextIntegrationStatus): void {
  if (status.persistentGrants.length === 0) {
    print.status("Persistent Team grants", "None");
  } else {
    for (const grant of status.persistentGrants) {
      const scope = grant.activationScope.kind === "directory" ? `directory ${grant.activationScope.root}` : "global";
      print.status("Persistent grant", `${grant.organizationId}; ${scope}`);
    }
  }
  if (status.effectiveCandidates.length === 0) {
    print.status("Effective candidates", "None for the current project");
    return;
  }
  for (const candidate of status.effectiveCandidates) {
    const scope =
      candidate.grant.activationScope.kind === "directory"
        ? `directory ${candidate.grant.activationScope.root}`
        : "global";
    const activation =
      candidate.activation.state === "connected"
        ? `${candidate.activation.team.displayName} (${candidate.activation.team.role})`
        : `${candidate.activation.state} — ${candidate.activation.message}`;
    print.status(
      "Effective candidate",
      `${candidate.grant.organizationId}; ${scope}; ${candidate.priority}; ${activation}`,
    );
  }
}

export const contextStatusCommand: SubcommandModule = {
  name: "status",
  alias: "",
  summary: "",
  description: "Inspect the shared Context Plugin, every persistent grant, and current effective candidates.",
  configure,
  action: runContextStatus,
};
