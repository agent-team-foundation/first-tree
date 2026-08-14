import type { FeishuBotBinding } from "@first-tree/shared";
import { ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { ReactElement } from "react";
import { getAgentFeishuBinding } from "../../api/agents.js";
import { Button } from "../../components/ui/button.js";

/**
 * Shared pieces for every surface that shows one Agent's Feishu Bot binding:
 * the Agent Detail Profile section and the focused OpenTag setup step.
 *
 * The binding itself — DTO, credentials, QR provisioning, connection — is
 * owned by the Feishu integration. What lives here is the read (so both
 * surfaces poll the same key at the same cadence and cannot drift apart) and
 * the two pieces of rendering that would otherwise be copied.
 */

const PROVISIONING_POLL_MS = 2_000;
const IDLE_POLL_MS = 10_000;

export function feishuBindingQueryKey(agentUuid: string): [string, string] {
  return ["agent-feishu-binding", agentUuid];
}

/**
 * One read contract for the binding: while Feishu is still provisioning the
 * Bot the member is watching the page, so it polls fast; afterwards it drops
 * back to an ambient refresh.
 */
export function feishuBindingQueryOptions(agentUuid: string) {
  return {
    queryKey: feishuBindingQueryKey(agentUuid),
    queryFn: () => getAgentFeishuBinding(agentUuid),
    refetchInterval: (state: { state: { data?: { binding: FeishuBotBinding | null } } }) =>
      state.state.data?.binding?.status === "provisioning" ? PROVISIONING_POLL_MS : IDLE_POLL_MS,
  };
}

/** The member-facing name for a binding's current state. */
export function feishuBindingLabel(
  status: FeishuBotBinding["status"],
  connectionStatus: FeishuBotBinding["connectionStatus"],
): string {
  if (status === "active" && connectionStatus === "connected") return "Connected";
  if (status === "provisioning" && connectionStatus === "connected") return "Connected · waiting for confirmation";
  if (status === "provisioning") return "Waiting for confirmation";
  if (status === "error") return "Needs attention";
  return status;
}

/**
 * Whether the Bot is genuinely reachable. `status: "active"` alone only means
 * the app exists — the socket may still be connecting or down — so a surface
 * that promises "you can message it now" has to consult both fields.
 */
export function isFeishuBotReachable(binding: FeishuBotBinding): boolean {
  return (
    (binding.status === "active" || binding.status === "provisioning") &&
    binding.connectionStatus === "connected" &&
    binding.appId !== null &&
    binding.botOpenId !== null
  );
}

/**
 * Whether the Agent's Feishu handoff is configured to carry work. Both halves
 * have to hold: the Bot must receive messages and the CLI must be ready to
 * answer them. Agent lifecycle is a separate caller-owned constraint.
 */
export function isFeishuHandoffUsable(binding: FeishuBotBinding | null): boolean {
  return !!binding && isFeishuBotReachable(binding) && binding.cli.state === "ready";
}

/**
 * The registration QR the member scans in Feishu, plus the same destination as
 * a link for anyone who is already signed in on this device.
 */
export function FeishuRegistrationQr({ registrationUrl }: { registrationUrl: string }): ReactElement {
  return (
    <div className="flex flex-col items-center" style={{ gap: "var(--sp-3)", padding: "var(--sp-4) 0" }}>
      <QRCodeSVG value={registrationUrl} size={184} marginSize={2} title="Feishu bot registration QR code" />
      <div className="text-label text-center" style={{ color: "var(--fg-3)" }}>
        Scan with Feishu, choose the existing Bot or create a new one, then confirm the requested permissions. This page
        updates automatically.
      </div>
      <Button size="xs" variant="outline" asChild>
        <a href={registrationUrl} target="_blank" rel="noreferrer">
          Open confirmation page <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Button>
    </div>
  );
}
