import { describe, expect, it } from "vitest";
import { MESSAGE_FORMATS, messageFormatSchema } from "../schemas/message.js";
import {
  QUESTION_STATUSES,
  questionAnswerMessageContentSchema,
  questionItemSchema,
  questionMessageContentSchema,
  questionOptionSchema,
  questionStatusSchema,
  submitQuestionAnswerSchema,
} from "../schemas/question.js";

const optionA = {
  label: "Yes",
  description: "Affirmative",
  preview: null,
};
const optionB = {
  label: "No",
  description: "Negative",
  preview: null,
};

const validQuestion = {
  question: "Should I proceed?",
  header: "Proceed?",
  options: [optionA, optionB],
  multiSelect: false,
};

const validContent = {
  correlationId: "tool_use_abc",
  questions: [validQuestion],
  previewFormat: null,
  allowFreeText: true,
};

describe("messageFormatSchema — new ask-user formats", () => {
  it("accepts 'question'", () => {
    expect(messageFormatSchema.safeParse("question").success).toBe(true);
    expect(MESSAGE_FORMATS.QUESTION).toBe("question");
  });

  it("accepts 'question_answer'", () => {
    expect(messageFormatSchema.safeParse("question_answer").success).toBe(true);
    expect(MESSAGE_FORMATS.QUESTION_ANSWER).toBe("question_answer");
  });
});

describe("questionOptionSchema", () => {
  it("accepts a valid option with null preview", () => {
    expect(questionOptionSchema.safeParse(optionA).success).toBe(true);
  });

  it("accepts a preview string", () => {
    const res = questionOptionSchema.safeParse({ ...optionA, preview: "<p>hi</p>" });
    expect(res.success).toBe(true);
  });

  it("rejects an empty label", () => {
    const res = questionOptionSchema.safeParse({ label: "", description: "x", preview: null });
    expect(res.success).toBe(false);
  });
});

describe("questionItemSchema", () => {
  it("accepts a valid single-select question", () => {
    expect(questionItemSchema.safeParse(validQuestion).success).toBe(true);
  });

  it("accepts a valid multi-select with 4 options", () => {
    const four = [optionA, optionB, { ...optionA, label: "Maybe" }, { ...optionA, label: "Later" }];
    const res = questionItemSchema.safeParse({
      ...validQuestion,
      options: four,
      multiSelect: true,
    });
    expect(res.success).toBe(true);
  });

  it("rejects only 1 option", () => {
    const res = questionItemSchema.safeParse({ ...validQuestion, options: [optionA] });
    expect(res.success).toBe(false);
  });

  it("rejects 5 options", () => {
    const res = questionItemSchema.safeParse({
      ...validQuestion,
      options: [optionA, optionA, optionA, optionA, optionA],
    });
    expect(res.success).toBe(false);
  });

  it("accepts a 13-char header (SDK occasionally emits slightly over 12)", () => {
    const res = questionItemSchema.safeParse({
      ...validQuestion,
      header: "ThirteenChars",
    });
    expect(res.success).toBe(true);
  });

  it("rejects header longer than 24 chars", () => {
    const res = questionItemSchema.safeParse({
      ...validQuestion,
      header: "ThisHeaderIsWayTooLongForTheChip",
    });
    expect(res.success).toBe(false);
  });

  it("accepts options with omitted preview field (SDK shape when no preview generated)", () => {
    const res = questionItemSchema.safeParse({
      ...validQuestion,
      options: [
        { label: "A", description: "alpha" }, // no preview key at all
        { label: "B", description: "beta" },
      ],
    });
    expect(res.success).toBe(true);
  });

  it("rejects empty question text", () => {
    const res = questionItemSchema.safeParse({ ...validQuestion, question: "" });
    expect(res.success).toBe(false);
  });
});

describe("questionMessageContentSchema", () => {
  it("accepts a single-question payload", () => {
    expect(questionMessageContentSchema.safeParse(validContent).success).toBe(true);
  });

  it("accepts up to 4 parallel questions", () => {
    const res = questionMessageContentSchema.safeParse({
      ...validContent,
      questions: [validQuestion, validQuestion, validQuestion, validQuestion],
    });
    expect(res.success).toBe(true);
  });

  it("rejects 0 questions", () => {
    const res = questionMessageContentSchema.safeParse({ ...validContent, questions: [] });
    expect(res.success).toBe(false);
  });

  it("rejects 5 questions", () => {
    const res = questionMessageContentSchema.safeParse({
      ...validContent,
      questions: Array(5).fill(validQuestion),
    });
    expect(res.success).toBe(false);
  });

  it("rejects missing correlationId", () => {
    const res = questionMessageContentSchema.safeParse({
      questions: [validQuestion],
      previewFormat: null,
      allowFreeText: true,
    });
    expect(res.success).toBe(false);
  });

  it("rejects empty correlationId", () => {
    const res = questionMessageContentSchema.safeParse({ ...validContent, correlationId: "" });
    expect(res.success).toBe(false);
  });

  it("accepts previewFormat = 'html' / 'markdown' / null", () => {
    expect(questionMessageContentSchema.safeParse({ ...validContent, previewFormat: "html" }).success).toBe(true);
    expect(questionMessageContentSchema.safeParse({ ...validContent, previewFormat: "markdown" }).success).toBe(true);
    expect(questionMessageContentSchema.safeParse({ ...validContent, previewFormat: null }).success).toBe(true);
  });

  it("rejects unknown previewFormat", () => {
    const res = questionMessageContentSchema.safeParse({
      ...validContent,
      previewFormat: "rtf",
    });
    expect(res.success).toBe(false);
  });
});

describe("questionAnswerMessageContentSchema", () => {
  it("accepts a normal answer record", () => {
    const res = questionAnswerMessageContentSchema.safeParse({
      correlationId: "tool_use_abc",
      answers: { "Should I proceed?": "Yes" },
    });
    expect(res.success).toBe(true);
  });

  it("accepts comma-joined multi-select answer values", () => {
    const res = questionAnswerMessageContentSchema.safeParse({
      correlationId: "tool_use_abc",
      answers: { "Pick languages": "TypeScript, Rust" },
    });
    expect(res.success).toBe(true);
  });

  it("accepts free-text answer (any string value)", () => {
    const res = questionAnswerMessageContentSchema.safeParse({
      correlationId: "tool_use_abc",
      answers: { "Anything else?": "I want to use Bun instead" },
    });
    expect(res.success).toBe(true);
  });

  it("rejects an empty key in answers", () => {
    const res = questionAnswerMessageContentSchema.safeParse({
      correlationId: "tool_use_abc",
      answers: { "": "Yes" },
    });
    expect(res.success).toBe(false);
  });

  it("rejects missing correlationId", () => {
    const res = questionAnswerMessageContentSchema.safeParse({
      answers: { q: "a" },
    });
    expect(res.success).toBe(false);
  });
});

describe("submitQuestionAnswerSchema", () => {
  it("accepts a normal body", () => {
    const res = submitQuestionAnswerSchema.safeParse({ answers: { q1: "a1" } });
    expect(res.success).toBe(true);
  });

  it("rejects body without answers", () => {
    expect(submitQuestionAnswerSchema.safeParse({}).success).toBe(false);
  });
});

describe("questionStatusSchema", () => {
  it("accepts pending / answered / superseded", () => {
    expect(questionStatusSchema.safeParse("pending").success).toBe(true);
    expect(questionStatusSchema.safeParse("answered").success).toBe(true);
    expect(questionStatusSchema.safeParse("superseded").success).toBe(true);
  });

  it("rejects unknown status", () => {
    expect(questionStatusSchema.safeParse("expired").success).toBe(false);
  });

  it("exposes constants", () => {
    expect(QUESTION_STATUSES.PENDING).toBe("pending");
    expect(QUESTION_STATUSES.ANSWERED).toBe("answered");
    expect(QUESTION_STATUSES.SUPERSEDED).toBe("superseded");
  });
});
