import { describe, expect, it } from "vitest";
import { isQuestionAnswerContent, isQuestionContent } from "../chat/question-message.js";

/**
 * Pin the type guards so the chat-view dispatch logic (commit 5) can rely
 * on them to safely narrow `MessageWithDelivery.content` (which is
 * `unknown` at the wire level). A regression here would either render
 * the JSON-stringified fallback for a real question (UX regression) or
 * crash on a malformed question payload (robustness regression).
 */

const validQuestionContent = {
  correlationId: "tu_1",
  questions: [
    {
      question: "Should I proceed?",
      header: "Proceed?",
      options: [
        { label: "Yes", description: "ok", preview: null },
        { label: "No", description: "no", preview: null },
      ],
      multiSelect: false,
    },
  ],
  previewFormat: null,
  allowFreeText: true,
};

const validAnswerContent = {
  correlationId: "tu_1",
  answers: { "Should I proceed?": "Yes" },
};

describe("isQuestionContent", () => {
  it("accepts a valid QuestionMessageContent", () => {
    expect(isQuestionContent(validQuestionContent)).toBe(true);
  });

  it("rejects when previewFormat is unknown", () => {
    expect(isQuestionContent({ ...validQuestionContent, previewFormat: "rtf" })).toBe(false);
  });

  it("rejects empty correlationId", () => {
    expect(isQuestionContent({ ...validQuestionContent, correlationId: "" })).toBe(false);
  });

  it("rejects payload with too few options", () => {
    expect(
      isQuestionContent({
        ...validQuestionContent,
        questions: [
          {
            ...validQuestionContent.questions[0],
            options: [{ label: "Only", description: "", preview: null }],
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects answer-shaped content", () => {
    expect(isQuestionContent(validAnswerContent)).toBe(false);
  });

  it("rejects null / non-object / string", () => {
    expect(isQuestionContent(null)).toBe(false);
    expect(isQuestionContent("text")).toBe(false);
    expect(isQuestionContent(42)).toBe(false);
  });
});

describe("isQuestionAnswerContent", () => {
  it("accepts a valid QuestionAnswerMessageContent", () => {
    expect(isQuestionAnswerContent(validAnswerContent)).toBe(true);
  });

  it("rejects when correlationId is missing", () => {
    expect(isQuestionAnswerContent({ answers: { q: "v" } })).toBe(false);
  });

  it("rejects question-shaped content", () => {
    expect(isQuestionAnswerContent(validQuestionContent)).toBe(false);
  });

  it("rejects empty answer keys", () => {
    expect(
      isQuestionAnswerContent({
        correlationId: "tu_1",
        answers: { "": "yes" },
      }),
    ).toBe(false);
  });
});
