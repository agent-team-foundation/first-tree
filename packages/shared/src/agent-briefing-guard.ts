/**
 * Guard against the "copied the assembled briefing back into a prompt"
 * failure mode.
 *
 * The on-disk `AGENTS.md` an agent sees is a *generated* artifact assembled
 * from several sources (team prompt resources, the per-agent prompt
 * fragment, and runtime-injected First Tree content). When an agent is asked
 * to edit its own prompt, the natural-but-wrong move is to copy that whole
 * assembled file and write it back into the per-agent fragment — freezing
 * team-shared and runtime-injected content into agent config. This module
 * detects that mistake at write time.
 *
 * Two detection tiers:
 *
 * - **Generated marker** — the briefing banner carries the literal
 *   `first-tree:generated` marker. Its presence in a prompt write is an
 *   unambiguous copy of the assembled file; the server hard-rejects it.
 * - **Briefing headings** — line-anchored section headings that only the
 *   assembled briefing contains. These are strong heuristics (a legitimate
 *   prompt could conceivably quote one), so the CLI rejects them with a
 *   `--force` escape hatch while the server lets them through.
 */

/** Literal marker embedded in the generated briefing's top banner. */
export const AGENT_BRIEFING_GENERATED_MARKER = "first-tree:generated";

/**
 * Line-anchored headings that only the assembled briefing contains. The
 * patterns match both the legacy bare headings and the provenance-suffixed
 * forms (e.g. `# Working in First Tree (First Tree Managed)`).
 */
const BRIEFING_HEADING_PATTERNS: ReadonlyArray<RegExp> = [
  /^# Working in First Tree\b.*$/m,
  /^# Required Reading\b.*$/m,
  /^## Current Chat Context\b.*$/m,
  // The legacy-fallback prompt section merges team-shared content into one
  // blob, so copying it back would freeze team prompts into agent config.
  // The structured `# Agent Prompt (this agent only — editable)` heading is
  // deliberately NOT guarded: its body is the agent's own fragment.
  /^# Agent Prompt \(legacy merged\b.*$/m,
];

export type BriefingFingerprint = {
  /** `generated-marker` is conclusive; `briefing-heading` is a heuristic. */
  kind: "generated-marker" | "briefing-heading";
  /** The matched text, for actionable error messages. */
  match: string;
};

/**
 * Scan a prompt body about to be persisted for traces of the assembled
 * briefing. Returns the first fingerprint found, or `null` when clean.
 */
export function findAssembledBriefingFingerprint(text: string): BriefingFingerprint | null {
  if (text.includes(AGENT_BRIEFING_GENERATED_MARKER)) {
    return { kind: "generated-marker", match: AGENT_BRIEFING_GENERATED_MARKER };
  }
  for (const pattern of BRIEFING_HEADING_PATTERNS) {
    const matched = text.match(pattern);
    if (matched) return { kind: "briefing-heading", match: matched[0] };
  }
  return null;
}
