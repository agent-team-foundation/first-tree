import { describe, expect, it } from "vitest";
import { buildClaudeSessionFlags } from "../handlers/claude-code-tui/index.js";

describe("buildClaudeSessionFlags", () => {
  it("pins new TUI sessions to the generated Claude session id", () => {
    expect(
      buildClaudeSessionFlags({ sessionId: "11111111-1111-4111-8111-111111111111", resumeSessionId: null }),
    ).toEqual(["--session-id", "11111111-1111-4111-8111-111111111111"]);
  });

  it("resumes existing sessions without passing a conflicting --session-id", () => {
    const flags = buildClaudeSessionFlags({
      sessionId: "22222222-2222-4222-8222-222222222222",
      resumeSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(flags).toEqual(["--resume", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    expect(flags).not.toContain("--session-id");
  });
});
