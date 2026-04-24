/**
 * Central place for outbound links. Hardcoded for the MVP — wire these
 * against real docs / quickstart URLs when they land. Every nav entry,
 * CTA, and footer link pulls from here so rename-once applies everywhere.
 */
export const LINKS = {
  repo: "https://github.com/agent-team-foundation/first-tree-hub",
  docs: "https://github.com/agent-team-foundation/first-tree-hub#readme",
  quickstart: "https://github.com/agent-team-foundation/first-tree-hub#common-commands",
  cliReference: "https://github.com/agent-team-foundation/first-tree-hub/blob/main/docs/cli-reference.md",
} as const;
