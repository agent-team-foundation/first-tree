import type { AgentType, AgentVisibility } from "@agent-team-foundation/first-tree-hub-shared";

export function humanizeAgentType(type: AgentType): string {
  switch (type) {
    case "human":
      return "Human";
    case "personal_assistant":
      return "Personal Assistant";
    case "autonomous_agent":
      return "Autonomous Agent";
  }
}

export function humanizeVisibility(visibility: AgentVisibility): string {
  // switch (not a ternary) so adding a new AgentVisibility value fails at
  // compile time instead of silently falling back to "Private". Mirrors
  // `humanizeAgentType` above.
  switch (visibility) {
    case "private":
      return "Private";
    case "organization":
      return "Organization";
  }
}
