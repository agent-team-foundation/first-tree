import type { FirstTreeHubSDK } from "@first-tree/client";
import type { DocCommentStatus } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { errorMessage } from "../../core/error-message.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseDocCommentStatus, parseVersionNumber, resolveDocBySlug } from "./_shared.js";

interface CommentsOptions {
  status?: string;
  version?: string;
  watch?: string | boolean;
  agent?: string;
}

const DEFAULT_WATCH_SECONDS = 15;
const MIN_WATCH_SECONDS = 5;

export function registerDocCommentsCommand(doc: Command): void {
  doc
    .command("comments <slug>")
    .description(
      "List a document's review comments. Each anchored comment carries quote/prefix/suffix so the text " +
        "range can be located in the markdown source; use the ids with `doc reply` and `doc resolve`.",
    )
    .option("--status <status>", "Filter by thread status: open | resolved")
    .option("--version <n>", "Only comments made against one version")
    .option(
      "--watch [seconds]",
      `After the initial listing, keep polling (default every ${DEFAULT_WATCH_SECONDS}s) and print each ` +
        "NEW comment as one JSON line on stdout. Runs until interrupted.",
    )
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (slug: string, options: CommentsOptions) => {
      const status = options.status === undefined ? undefined : parseDocCommentStatus(options.status);
      const versionNumber = options.version === undefined ? undefined : parseVersionNumber(options.version);
      const watchSeconds = parseWatchSeconds(options.watch);
      try {
        const sdk = createSdk(options.agent);
        const summary = await resolveDocBySlug(sdk, slug);
        const { items } = await sdk.listDocComments(summary.id, { status, versionNumber });
        success({ documentId: summary.id, slug: summary.slug, latestVersion: summary.latestVersion, items });
        if (watchSeconds !== null) {
          await watchComments(
            sdk,
            summary.id,
            { status, versionNumber },
            watchSeconds,
            items.map((c) => c.id),
          );
        }
      } catch (error) {
        handleSdkError(error);
      }
    });
}

function parseWatchSeconds(value: string | boolean | undefined): number | null {
  if (value === undefined || value === false) return null;
  if (value === true) return DEFAULT_WATCH_SECONDS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < MIN_WATCH_SECONDS) {
    fail("INVALID_INTERVAL", `Invalid --watch interval "${value}". Expected an integer ≥ ${MIN_WATCH_SECONDS}.`, 2);
  }
  return parsed;
}

/**
 * Poll loop: each new comment prints as a single JSON line (NDJSON) after the
 * initial `success()` envelope, so scripts can stream on top of the snapshot.
 * Transient poll errors go to stderr and the loop keeps going.
 */
async function watchComments(
  sdk: FirstTreeHubSDK,
  documentId: string,
  query: { status?: DocCommentStatus; versionNumber?: number },
  intervalSeconds: number,
  initialIds: string[],
): Promise<never> {
  const seen = new Set(initialIds);
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    try {
      const { items } = await sdk.listDocComments(documentId, query);
      for (const comment of items) {
        if (seen.has(comment.id)) continue;
        seen.add(comment.id);
        process.stdout.write(`${JSON.stringify(comment)}\n`);
      }
    } catch (error) {
      const msg = errorMessage(error);
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "WATCH_POLL_FAILED", message: msg } })}\n`);
    }
  }
}
