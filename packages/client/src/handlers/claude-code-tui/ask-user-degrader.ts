/**
 * AskUserQuestion is the only tool whose default behaviour requires the user
 * to interact with claude's TUI selection menu — which the tmux runtime
 * cannot do. We keep the tool enabled (claude is free to invoke it whenever
 * it judges useful) and gracefully degrade each invocation to a plain-text
 * round-trip:
 *
 *   1. Detect the selection menu via the `Enter to select` pane footer.
 *   2. Send Escape to cancel — claude flushes the cancelled `tool_use(input)`
 *      to the transcript (verified end-to-end in the PoC).
 *   3. The handler picks up the cancelled `tool_use` from the transcript
 *      tail and formats `input.questions` as markdown.
 *   4. That text is forwarded to the chat. The next user reply is injected
 *      as a normal user turn; claude sees its own cancelled tool call and
 *      continues naturally.
 *
 * This module owns step (4)'s formatting only — menu detection lives in
 * `index.ts`'s turn loop where it has the capture-pane handle.
 */

type AskUserOption = {
  label?: unknown;
  description?: unknown;
};

type AskUserQuestionItem = {
  question?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  options?: unknown;
};

type AskUserInput = {
  questions?: unknown;
};

/**
 * Render the AskUserQuestion `input.questions` payload as markdown the user
 * can answer in free text. Defensive against missing / malformed fields so
 * we never throw on a transcript entry — the format is whatever claude
 * decided to send, and we'd rather degrade than drop the message.
 */
export function formatQuestionsAsText(input: unknown): string {
  const questions = extractQuestionList(input);
  if (questions.length === 0) {
    return "Claude wanted to ask you something, but the question payload was empty. Please reply with what you'd like it to do next.";
  }

  const lines: string[] = ["Claude has a question for you:", ""];
  questions.forEach((q, idx) => {
    const heading = questions.length > 1 ? `${idx + 1}. ` : "";
    const questionText = typeof q.question === "string" ? q.question : "(no question text)";
    lines.push(`${heading}**${questionText}**`);
    if (typeof q.header === "string" && q.header.trim().length > 0) {
      lines.push(`   _${q.header}_`);
    }

    const options = extractOptionList(q.options);
    if (options.length > 0) {
      const multi = q.multiSelect === true;
      lines.push(`   _Options${multi ? " (multi-select)" : ""}:_`);
      for (const opt of options) {
        const label = typeof opt.label === "string" ? opt.label : "(option)";
        const description = typeof opt.description === "string" ? opt.description.trim() : "";
        lines.push(description ? `   - **${label}** — ${description}` : `   - **${label}**`);
      }
    }
    lines.push("");
  });

  lines.push("Reply with your answer in plain text.");
  return lines.join("\n");
}

function extractQuestionList(input: unknown): AskUserQuestionItem[] {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const questions = (input as AskUserInput).questions;
    if (Array.isArray(questions)) return questions as AskUserQuestionItem[];
  }
  return [];
}

function extractOptionList(options: unknown): AskUserOption[] {
  if (!Array.isArray(options)) return [];
  return options as AskUserOption[];
}
