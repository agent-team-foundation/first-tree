import { fail } from "../../../cli/output.js";

/**
 * Hard caps on the structured ask. `--question` is the short ask the web pins
 * above the composer (RequestDock); `--subject` is its headline. Background
 * and context belong in the message body, which renders as markdown in the
 * request card.
 */
export const REQUEST_QUESTION_MAX_CHARS = 200;
export const REQUEST_SUBJECT_MAX_CHARS = 80;

export type RequestCliOptions = {
  subject?: string;
  question?: string;
  option?: string[];
};

export function buildRequestMetadata(
  metadata: Record<string, unknown> | undefined,
  options: RequestCliOptions,
): Record<string, unknown> {
  if (!options.question) {
    fail("REQUEST_NEEDS_QUESTION", "--request needs --question <text>.", 2);
  }
  if (options.question.length > REQUEST_QUESTION_MAX_CHARS) {
    fail(
      "QUESTION_TOO_LONG",
      `--question must stay a short ask (≤${REQUEST_QUESTION_MAX_CHARS} chars, got ${options.question.length}). ` +
        "Move the background/context into the message body — it renders as the request card's markdown body; " +
        "the question is pinned verbatim above the composer.",
      2,
    );
  }
  if (options.subject && options.subject.length > REQUEST_SUBJECT_MAX_CHARS) {
    fail(
      "SUBJECT_TOO_LONG",
      `--subject is a headline (≤${REQUEST_SUBJECT_MAX_CHARS} chars, got ${options.subject.length}). ` +
        "Keep it to a few words; details belong in the body or --question.",
      2,
    );
  }

  const opts = options.option ?? [];
  return {
    ...(metadata ?? {}),
    request: {
      ...(options.subject ? { subject: options.subject } : {}),
      questions: [
        {
          id: "q1",
          prompt: options.question,
          kind: opts.length > 0 ? "single" : "free",
          options: opts,
          required: true,
        },
      ],
    },
  };
}
