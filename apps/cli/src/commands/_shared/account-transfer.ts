import { FirstTreeHubSDK } from "@first-tree/client";
import { confirm } from "@inquirer/prompts";
import { fail } from "../../cli/output.js";
import { findStaleAliases, formatStaleReason, removeLocalAgent } from "../../core/agent-prune.js";
import { ensureFreshAccessToken } from "../../core/bootstrap.js";
import { cliFetch } from "../../core/cli-fetch.js";
import { print } from "../../core/output.js";
import { CLI_USER_AGENT } from "../../core/version.js";

/**
 * Server-side claim: transfer ownership of this machine's `client.id` to the
 * current member, unpinning the previous owner's agents.
 *
 * Mirrors what the old top-level `client claim` did, kept here as a helper so
 * `login --override` can call it inline. Caller is responsible for printing a
 * "transferring..." preamble before invoking.
 *
 * Throws on HTTP error; caller decides whether to wrap in fail() (login does).
 */
export async function postClaim(
  serverUrl: string,
  clientId: string,
): Promise<{ clientId: string; previousUserId: string | null; unpinnedAgentCount: number }> {
  const token = await ensureFreshAccessToken();
  const response = await cliFetch(`${serverUrl}/api/v1/clients/${encodeURIComponent(clientId)}/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.text();
    fail("CLAIM_ERROR", `Server returned ${response.status}: ${body}`, 1);
  }
  return (await response.json()) as {
    clientId: string;
    previousUserId: string | null;
    unpinnedAgentCount: number;
  };
}

/**
 * After a claim, the previous owner's pinned agents are unpinned server-side
 * but their `agents/<name>/agent.yaml` files still sit on disk. Without
 * cleanup, the next `daemon start` tries to bind those orphaned agentIds,
 * R-RUN rejects each one, and doctor keeps reporting the inflated count.
 * Detect + offer to prune in the same breath as the claim.
 *
 * `nonInteractive` defaults to false. When true, accept the cleanup without
 * prompting (caller has already collected user consent via the parent flow's
 * `--override` / `--confirm` flag).
 */
export async function cleanupStaleAliasesAfterClaim(opts: {
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
      print.line("  Skipped. Run `first-tree agent prune` later to clean up.\n");
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
    print.line("  Run `first-tree agent prune` after reconnecting.\n");
  }
}
