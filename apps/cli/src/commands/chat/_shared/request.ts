import { askOptionSchema } from "@first-tree/shared";
import { z } from "zod";
import { fail } from "../../../cli/output.js";

/** Provided options come 2–4 at a time, each `{label (1–5 words), description, preview?}`. */
const optionsArraySchema = z.array(askOptionSchema).min(2).max(4);

export type RequestCliOptions = {
  /** Raw JSON passed to `--options`: an array of `{label, description, preview?}`. */
  options?: string;
  /** `--multi-select`: allow picking more than one option (requires `--options`). */
  multiSelect?: boolean;
};

/**
 * Build `metadata.request` for an ask. The ask itself is the message body; this
 * payload carries only the answer affordance:
 *   - no `--options` → free-text answer (empty `request`).
 *   - `--options '<json>'` → 2–4 options; `--multi-select` toggles multiple.
 */
export function buildRequestMetadata(
  metadata: Record<string, unknown> | undefined,
  options: RequestCliOptions,
): Record<string, unknown> {
  let parsedOptions: z.infer<typeof optionsArraySchema> | undefined;
  if (options.options !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(options.options);
    } catch {
      fail("INVALID_OPTIONS", "--options must be valid JSON: an array of {label, description, preview?}.", 2);
    }
    const result = optionsArraySchema.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0];
      fail(
        "INVALID_OPTIONS",
        "--options must be 2–4 items of {label (1–5 words), description, preview?}" +
          (issue ? ` — ${issue.path.join(".") || "options"}: ${issue.message}` : "") +
          ".",
        2,
      );
    }
    parsedOptions = result.data;
  }

  if (options.multiSelect && !parsedOptions) {
    fail("MULTISELECT_NEEDS_OPTIONS", "--multi-select requires --options.", 2);
  }

  const request: Record<string, unknown> = {};
  if (parsedOptions) request.options = parsedOptions;
  if (options.multiSelect) request.multiSelect = true;

  return { ...(metadata ?? {}), request };
}
