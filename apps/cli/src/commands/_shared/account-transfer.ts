import { FirstTreeHubSDK } from "@first-tree/client";
import { confirm } from "@inquirer/prompts";
import { findStaleAliases, formatStaleReason, removeLocalAgent } from "../../core/agent-prune.js";
import { ensureFreshAccessToken } from "../../core/bootstrap.js";
import { channelConfig } from "../../core/channel.js";
import { print } from "../../core/output.js";
import { CLI_USER_AGENT } from "../../core/version.js";

/**
 * After `login --override` rotates the machine's client identity, the local
 * `agents/<name>/agent.yaml` files still reference agents pinned to the OLD
 * clientId (owned by the previous account). Without cleanup, the next
 * `daemon start` tries to bind those agentIds, R-RUN rejects each one, and
 * doctor keeps reporting the inflated count. Detect + offer to prune in the
 * same breath as the rotation.
 *
 * `nonInteractive` defaults to false. When true, accept the cleanup without
 * prompting (caller has already collected user consent via the parent flow's
 * `--override` / `--confirm` flag).
 */
export async function cleanupStaleLocalAliases(opts: {
  serverUrl: string;
  clientId: string;
  nonInteractive?: boolean;
}): Promise<void> {
  const { serverUrl, clientId, nonInteractive = false } = opts;
  try {
    const sdk = new FirstTreeHubSDK({
      serverUrl,
      getAccessToken: (o) => ensureFreshAccessToken(o),
      userAgent: CLI_USER_AGENT,
    });
    const stale = await findStaleAliases({
      clientId,
      listPinnedAgents: () => sdk.listMyAgents(),
    });
    if (stale.length === 0) {
      print.line("  No stale local aliases — local config already matches the server.\n");
      return;
    }
    print.line(`\n  ${stale.length} local ${stale.length === 1 ? "alias" : "aliases"} won't bind on this client:\n\n`);
    for (const s of stale) {
      const id = s.agentId ?? "—";
      print.line(`    - ${s.name.padEnd(30)} ${id.padEnd(38)} ${formatStaleReason(s.reason)}\n`);
    }
    print.line("\n");

    const approved =
      nonInteractive === true
        ? true
        : await confirm({
            message: `Remove the ${stale.length} stale ${stale.length === 1 ? "alias" : "aliases"} above (config + workspace + session state)?`,
            default: true,
          }).catch(() => false);

    if (!approved) {
      print.line(`  Skipped. Run \`${channelConfig.binName} agent prune\` later to clean up.\n`);
      return;
    }

    let removed = 0;
    let failed = 0;
    for (const s of stale) {
      try {
        removeLocalAgent(s.name);
        print.line(`  ✓ removed ${s.name}\n`);
        removed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  ✗ ${s.name} (${msg.slice(0, 80)})\n`);
        failed++;
      }
    }
    print.line(`\n  ${removed} pruned${failed > 0 ? `, ${failed} failed (re-run \`agent prune\` to retry)` : ""}.\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    print.line(`  (Could not check for stale aliases: ${msg.slice(0, 100)})\n`);
    print.line(`  Run \`${channelConfig.binName} agent prune\` after reconnecting.\n`);
  }
}
