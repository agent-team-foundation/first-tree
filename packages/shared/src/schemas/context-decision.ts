import { z } from "zod";
import { contextTreeRepoSchema } from "./org-settings.js";

/**
 * `metadata.contextDecision` — an agent's self-attributed record that Context
 * Tree content materially shaped the choice carried by THIS message.
 *
 * Legacy agents wrote this receipt on the same final `chat send` (or blocking
 * `chat ask`) that contained the affected choice. New `first-tree-read`
 * payloads use a portable note in the message body instead; this schema remains
 * the compatibility contract for stored history and older agents. The receipt
 * is the agent's own report: First Tree preserves the cited
 * repository/commit/path so a reader can inspect the exact source, but it does
 * NOT independently verify that the passage caused the choice. Every consumer
 * must present it as agent-reported, never as a system-verified causal claim.
 *
 * Trust boundary: the server strips the key from human senders and rejects a
 * malformed receipt from an agent sender, so a stored receipt is always an
 * agent's and always parses. Readers still parse defensively (`safeParse` via
 * `readContextDecisionMetadata`) because message rows are immutable — history
 * written before that guard is not re-validated.
 */
export const CONTEXT_DECISION_METADATA_KEY = "contextDecision";

/**
 * How Tree content acted on the choice. Exactly one applies; the skill picks
 * the first matching category in this precedence order so reports stay
 * comparable:
 *
 *   - `conflicted`  — exposed a conflict that still needs resolution/escalation
 *   - `redirected`  — changed the intended approach
 *   - `constrained` — ruled out an option or narrowed the solution boundary
 *   - `confirmed`   — removed material uncertainty and justified keeping the
 *                     choice without changing its boundary
 */
export const contextDecisionEffectSchema = z.enum(["conflicted", "redirected", "constrained", "confirmed"]);
export type ContextDecisionEffect = z.infer<typeof contextDecisionEffectSchema>;

/** At most three node paths may jointly influence one choice (skill contract). */
export const MAX_CONTEXT_DECISION_EVIDENCE = 3;
export const MAX_CONTEXT_DECISION_SUMMARY_LENGTH = 400;
export const MAX_CONTEXT_DECISION_REPO_URL_LENGTH = 2_000;

/**
 * One cited passage: the exact repository + commit + Tree-root-relative node
 * path that supplied it. `repoUrl` is the credential-free binding repository as
 * the activation receipt / workspace briefing declares it — never a local
 * transport URL and never a credential-bearing remote, so a stored receipt can
 * be shown and linked without leaking a secret.
 */
export const contextDecisionEvidenceSchema = z.object({
  /**
   * The SAME contract the Context Tree binding itself is validated against.
   * The producer copies the declared binding repository verbatim, so a second
   * URL rule here could only drift from it: a stricter one rejects a valid
   * binding (`ssh://git@host/path` carries a username by design) and a looser
   * one admits shapes the binding would refuse. `contextTreeRepoSchema` already
   * requires https / ssh / scp-like transport with a host and repository path,
   * and rejects embedded passwords, HTTPS usernames, query and fragment
   * components, control characters, and line separators — so a credential
   * cannot ride any of the three forms into an immutable message row.
   */
  repoUrl: contextTreeRepoSchema.refine((value) => value.length <= MAX_CONTEXT_DECISION_REPO_URL_LENGTH, {
    message: `repoUrl must be at most ${MAX_CONTEXT_DECISION_REPO_URL_LENGTH} characters`,
  }),
  /**
   * The exact commit the passage was read at. A clone identity resolves an
   * abbreviation against one repository at one moment, so only a full object id
   * keeps naming the same immutable version for the life of the stored receipt.
   * SHA-1 (40) and SHA-256 (64) are the two legal lengths; every producer path
   * emits one because the receipt is built from `git rev-parse HEAD`.
   */
  commit: z
    .string()
    .regex(/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/, "commit must be a full SHA-1 (40) or SHA-256 (64) object id"),
  /** Tree-root-relative path, e.g. `system/cloud/team/tenancy-and-identity.md`. */
  nodePath: z
    .string()
    .min(1)
    .max(1_000)
    .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
      message: "nodePath must be a tree-root-relative path without `..` segments",
    }),
  /** Optional heading inside the node; omitted when it cannot be named reliably. */
  heading: z.string().min(1).max(200).optional(),
});
export type ContextDecisionEvidence = z.infer<typeof contextDecisionEvidenceSchema>;

export const contextDecisionSchema = z.object({
  version: z.literal(1),
  effect: contextDecisionEffectSchema,
  /** One concrete sentence naming what the Tree content actually did here. */
  summary: z.string().trim().min(1).max(MAX_CONTEXT_DECISION_SUMMARY_LENGTH),
  /**
   * Required: a receipt with nothing to inspect is a claim, not a receipt —
   * the inspectable source is the only part First Tree can vouch for.
   */
  evidence: z.array(contextDecisionEvidenceSchema).min(1).max(MAX_CONTEXT_DECISION_EVIDENCE),
});
export type ContextDecision = z.infer<typeof contextDecisionSchema>;

/**
 * Strict reader for a stored message's receipt. Returns `null` for absent,
 * unknown-version, or malformed payloads so a renderer fails closed (shows
 * nothing) instead of rendering a partial, misleading influence claim.
 */
export function readContextDecisionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ContextDecision | null {
  if (metadata?.[CONTEXT_DECISION_METADATA_KEY] === undefined) return null;
  const parsed = contextDecisionSchema.safeParse(metadata[CONTEXT_DECISION_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}
