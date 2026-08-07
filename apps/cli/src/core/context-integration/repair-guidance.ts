import type { ContextIntegrationProvider } from "@first-tree/shared";
import { channelConfig } from "../channel.js";

export function contextRepairCommand(provider: ContextIntegrationProvider): string {
  return `${channelConfig.binName} context repair --provider ${provider}`;
}

export function contextRepairAdditionalContext(provider: ContextIntegrationProvider): string {
  const command = contextRepairCommand(provider);
  return [
    "First Tree Context cannot be safely updated automatically because its local state is incomplete, corrupt, from another account/channel, or would require a downgrade.",
    "Ordinary provider work can continue without First Tree Context.",
    "Do not edit provider cache, First Tree config, manifests, receipts, or journals by hand.",
    `Explain the blocker briefly. Only after the user asks to repair this exceptional state, run \`${command}\`.`,
    provider === "claude-code"
      ? `After repair, run \`${channelConfig.binName} context status --provider ${provider}\`, then start a new Claude session.`
      : `After repair, run \`${channelConfig.binName} context status --provider ${provider}\`; manually activate First Tree Context if the current session still needs it.`,
  ].join("\n");
}

export function contextRepairUnavailableMessage(
  provider: ContextIntegrationProvider,
  issues: readonly string[],
): string {
  return [issues.join(" "), contextRepairAdditionalContext(provider)].filter(Boolean).join("\n");
}
