import { describe, expect, it } from "vitest";
import { AGENT_BRIEFING_GENERATED_MARKER, findAssembledBriefingFingerprint } from "../agent-briefing-guard.js";

// Write-side guard against the "copied the assembled AGENTS.md back into the
// per-agent prompt" failure mode. Tier semantics under test:
//   - generated marker → conclusive (server hard-rejects, CLI has no --force)
//   - briefing heading → heuristic (CLI rejects with --force escape; server
//     lets it through)

describe("findAssembledBriefingFingerprint", () => {
  it("returns null for ordinary prompt text, including prose that merely mentions First Tree", () => {
    expect(findAssembledBriefingFingerprint("")).toBeNull();
    expect(findAssembledBriefingFingerprint("You are a code reviewer. Be strict but kind.")).toBeNull();
    // Mentions without the line-anchored heading shape must not trip the
    // heuristic — agents legitimately write about the platform.
    expect(findAssembledBriefingFingerprint("Remember you are working in First Tree, so use chat send.")).toBeNull();
    // Headings are line-anchored: an inline occurrence mid-line is clean.
    expect(findAssembledBriefingFingerprint("See the `# Working in First Tree` section for details.")).toBeNull();
  });

  it("flags the generated marker as conclusive, anywhere in the text", () => {
    const result = findAssembledBriefingFingerprint(
      `prefix\n<!-- ${AGENT_BRIEFING_GENERATED_MARKER} — rebuilt every session -->\nsuffix`,
    );
    expect(result).toEqual({ kind: "generated-marker", match: AGENT_BRIEFING_GENERATED_MARKER });
  });

  it("marker wins over headings when both are present (it is the conclusive tier)", () => {
    const result = findAssembledBriefingFingerprint(
      `${AGENT_BRIEFING_GENERATED_MARKER}\n\n# Working in First Tree (First Tree Managed)\n`,
    );
    expect(result?.kind).toBe("generated-marker");
  });

  it("flags line-anchored briefing headings — both legacy bare and provenance-suffixed forms", () => {
    const cases: Array<[string, string]> = [
      ["# Working in First Tree", "# Working in First Tree"],
      ["# Working in First Tree (First Tree Managed)", "# Working in First Tree (First Tree Managed)"],
      ["# Required Reading", "# Required Reading"],
      ["# Required Reading (First Tree Managed)", "# Required Reading (First Tree Managed)"],
      ["## Current Chat Context", "## Current Chat Context"],
      [
        "## Current Chat Context (First Tree Managed, per-chat)",
        "## Current Chat Context (First Tree Managed, per-chat)",
      ],
      // The legacy-fallback prompt heading marks a merged blob that embeds
      // team-shared content; copying it back would freeze team prompts.
      [
        "# Agent Prompt (legacy merged — may include team-shared content)",
        "# Agent Prompt (legacy merged — may include team-shared content)",
      ],
    ];
    for (const [heading, expectedMatch] of cases) {
      const result = findAssembledBriefingFingerprint(`Some intro.\n\n${heading}\n\nBody.`);
      expect(result, `heading "${heading}" should be flagged`).toEqual({
        kind: "briefing-heading",
        match: expectedMatch,
      });
    }
  });

  it("does not flag headings that merely share a prefix word boundary", () => {
    // `\b`-anchored patterns must not match extended words…
    expect(findAssembledBriefingFingerprint("# Working in First Trees\n")).toBeNull();
    // …but a colon/suffix after the exact phrase is still the briefing shape.
    expect(findAssembledBriefingFingerprint("# Required Reading: extras\n")?.kind).toBe("briefing-heading");
  });

  it("does not flag the structured editable agent-prompt heading", () => {
    // The structured heading's body is the agent's own fragment — copying it
    // back is harmless duplication, unlike the legacy merged blob.
    expect(findAssembledBriefingFingerprint("# Agent Prompt (this agent only — editable)\n")).toBeNull();
  });
});
