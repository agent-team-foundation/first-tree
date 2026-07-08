import type { FirstTreeHubSDK } from "@first-tree/client";
import type { DocCommentStatus, DocStatus, DocSummary } from "@first-tree/shared";
import { docCommentStatusSchema, docStatusSchema } from "@first-tree/shared";
import { fail } from "../../cli/output.js";

/** Resolve a slug to its document summary, or exit with a scriptable error. */
export async function resolveDocBySlug(sdk: FirstTreeHubSDK, slug: string): Promise<DocSummary> {
  const { items } = await sdk.listDocs({ slug, limit: 1 });
  const doc = items[0];
  if (!doc) {
    fail(
      "DOC_NOT_FOUND",
      `No document with slug "${slug}" in this org. \`doc list\` shows available slugs; \`doc publish\` creates one.`,
      1,
    );
  }
  return doc;
}

/** Validate a --status value at the argument layer (exit 2, not a server 400). */
export function parseDocStatus(value: string): DocStatus {
  const parsed = docStatusSchema.safeParse(value);
  if (!parsed.success) {
    fail("INVALID_STATUS", `Invalid status "${value}". Expected: draft | in_review | approved | archived.`, 2);
  }
  return parsed.data;
}

export function parseDocCommentStatus(value: string): DocCommentStatus {
  const parsed = docCommentStatusSchema.safeParse(value);
  if (!parsed.success) {
    fail("INVALID_STATUS", `Invalid comment status "${value}". Expected: open | resolved.`, 2);
  }
  return parsed.data;
}

/** Parse a --version integer at the argument layer. */
export function parseVersionNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    fail("INVALID_VERSION", `Invalid version "${value}". Expected a positive integer.`, 2);
  }
  return parsed;
}
