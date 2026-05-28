import { readFileSync } from "node:fs";
import { fail } from "../../../cli/output.js";
import { readStdin } from "../../chat/_shared/io.js";

/**
 * Resolve a `--body` flag value. Accepts: literal text, `@path/to/file.md`
 * to load from disk, or `@-` / omitted-flag-with-piped-stdin to read from
 * stdin. `undefined` with a TTY stdin yields the empty string — matching
 * `raiseAttentionInputSchema.body`'s default.
 */
export async function resolveBody(raw: string | undefined): Promise<string> {
  if (raw === undefined) {
    const piped = await readStdin();
    return piped ?? "";
  }
  if (raw === "@-") {
    const piped = await readStdin();
    if (piped === null) {
      fail("BODY_READ_FAILED", "`--body @-` requires piped stdin (no TTY).", 2);
    }
    return piped;
  }
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
