import { readFileSync } from "node:fs";
import { fail } from "../../../cli/output.js";

/**
 * Resolve a `--body` flag value. The `@file` syntax loads from disk so
 * agents can attach long markdown bodies without shell-quoting hell;
 * everything else is taken as the literal body text. `undefined` yields
 * the empty string — matching `raiseAttentionInputSchema.body`'s default.
 */
export function resolveBody(raw: string | undefined): string {
  if (raw === undefined) return "";
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    try {
      return readFileSync(path, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail("BODY_READ_FAILED", `Could not read --body file "${path}": ${msg}`, 2);
    }
  }
  return raw;
}
