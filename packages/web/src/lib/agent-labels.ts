import type { AgentType, AgentVisibility } from "@first-tree/shared";

export function humanizeAgentType(type: AgentType): string {
  switch (type) {
    case "human":
      return "Human";
    case "agent":
      return "Agent";
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
