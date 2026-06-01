import { describe, expect, it } from "vitest";
import { formatQuestionsAsText } from "../handlers/claude-code-tui/ask-user-degrader.js";

describe("formatQuestionsAsText", () => {
  it("renders a single question with options as readable markdown", () => {
    const text = formatQuestionsAsText({
      questions: [
        {
          question: "Pick a fruit",
          header: "Fruit",
          multiSelect: false,
          options: [
            { label: "Apple", description: "Red and round" },
            { label: "Banana" },
            { label: "Cherry", description: "Small and tart" },
          ],
        },
      ],
    });

    expect(text).toContain("Claude has a question for you");
    expect(text).toContain("**Pick a fruit**");
    expect(text).toContain("_Fruit_");
    expect(text).toContain("**Apple** — Red and round");
    expect(text).toContain("**Banana**"); // no description -> no em-dash trailer
    expect(text).not.toContain("**Banana** — ");
    expect(text).toContain("**Cherry** — Small and tart");
    expect(text).toContain("_Options:_");
    expect(text).toContain("Reply with your answer in plain text.");
  });

  it("numbers each question when multiple are present", () => {
    const text = formatQuestionsAsText({
      questions: [
        { question: "First?", options: [{ label: "Yes" }] },
        { question: "Second?", options: [{ label: "No" }] },
      ],
    });

    expect(text).toMatch(/1\. \*\*First\?\*\*/);
    expect(text).toMatch(/2\. \*\*Second\?\*\*/);
  });

  it("annotates multi-select questions in the options heading", () => {
    const text = formatQuestionsAsText({
      questions: [
        {
          question: "Pick all that apply",
          multiSelect: true,
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    });

    expect(text).toContain("_Options (multi-select):_");
  });

  it("falls back gracefully when input is empty or malformed", () => {
    expect(formatQuestionsAsText(undefined)).toContain("payload was empty");
    expect(formatQuestionsAsText({})).toContain("payload was empty");
    expect(formatQuestionsAsText({ questions: [] })).toContain("payload was empty");
    expect(formatQuestionsAsText({ questions: "not an array" })).toContain("payload was empty");
  });

  it("tolerates missing question text and option labels", () => {
    const text = formatQuestionsAsText({
      questions: [
        {
          // no `question` field
          options: [
            {
              /* no label */
            },
            { label: "Real" },
          ],
        },
      ],
    });
    expect(text).toContain("(no question text)");
    expect(text).toContain("(option)");
    expect(text).toContain("**Real**");
  });
});
