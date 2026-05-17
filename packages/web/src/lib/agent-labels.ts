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
  return visibility === "organization" ? "Organization" : "Private";
}
