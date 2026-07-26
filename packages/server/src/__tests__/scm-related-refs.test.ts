import { describe, expect, it } from "vitest";
import { parseSameProjectClosingIssueRefs } from "../services/scm-related-refs.js";

describe("parseSameProjectClosingIssueRefs", () => {
  it("parses and deduplicates the shared same-project closing subset", () => {
    expect(
      parseSameProjectClosingIssueRefs("Closes #12, fixes #12, RESOLVED #14, resolves group/other#9", "acme/api"),
    ).toEqual([
      { type: "issue", key: "acme/api#12" },
      { type: "issue", key: "acme/api#14" },
    ]);
  });

  it("ignores references in inline and fenced code", () => {
    expect(
      parseSameProjectClosingIssueRefs("`fixes #1`\n```\ncloses #2\n```\nResolves #3", "77", (project, issue) => {
        return `${project}:issue:${issue}`;
      }),
    ).toEqual([{ type: "issue", key: "77:issue:3" }]);
  });
});
