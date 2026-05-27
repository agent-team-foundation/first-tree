import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { AttentionRespondError, respondAttention } from "../../core/attention/index.js";
import { print } from "../../core/output.js";
import { collectMeta } from "./_shared/meta.js";

interface RespondOptions {
  text?: string;
  answer: string[];
}

export function registerAttentionRespondCommand(parent: Command): void {
  parent
    .command("respond <id>")
    .description("Respond to an open attention targeting you (member-scoped — uses your user token)")
    .option("--text <text>", "Free-form text response (`text` field on the wire)")
    .option(
      "--answer <key=value>",
      "Structured answer field; repeatable. Accumulated into the `answers` object keyed by question id (or `default`).",
      collectMeta,
      [],
    )
    .action(async (id: string, options: RespondOptions) => {
      try {
        const hasText = options.text !== undefined && options.text.length > 0;
        const hasAnswers = options.answer.length > 0;
        if (!hasText && !hasAnswers) {
          fail("RESPONSE_REQUIRED", "Pass either --text <...> or one or more --answer key=value flags.", 2);
        }

        let answers: Record<string, unknown> | undefined;
        if (hasAnswers) {
          if (hasText) {
            print.line("warning: both --text and --answer provided; --text wins, --answer ignored.\n");
          } else {
            answers = {};
            for (const raw of options.answer) {
              const eq = raw.indexOf("=");
              if (eq <= 0) {
                fail("INVALID_ANSWER", `Bad --answer value "${raw}". Expected "key=value".`, 2);
              }
              const key = raw.slice(0, eq);
              const value = raw.slice(eq + 1);
              answers[key] = value;
            }
          }
        }

        const attention = await respondAttention({
          id,
          text: hasText ? options.text : undefined,
          answers: hasText ? undefined : answers,
        });
        success(attention);
      } catch (error) {
        if (error instanceof AttentionRespondError) {
          const exitCode = error.statusCode === 401 ? 3 : 1;
          fail(`HTTP_${error.statusCode}`, error.message, exitCode);
        }
        const msg = error instanceof Error ? error.message : String(error);
        fail("UNKNOWN_ERROR", msg, 1);
      }
    });
}
