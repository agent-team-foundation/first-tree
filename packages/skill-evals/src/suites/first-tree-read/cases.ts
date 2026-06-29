import type { FirstTreeReadEvalCase } from "./types.js";

const JWT_AUTH_EXPECTED_FACTS = [
  "User JWT auth is the unified authorization surface.",
  "Route scopes must be checked against live organization membership before cross-org actions.",
  "HTTP routes must follow the repo path conventions document before auth or multi-org changes.",
] as const;

export const FIRST_TREE_READ_CASES: readonly FirstTreeReadEvalCase[] = [
  {
    description: "Blank workspace with first-tree-read installed and a casual prompt.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: false,
    id: "blank-casual-no-trigger",
    prompt: "Please explain the Pomodoro technique in one sentence.",
    promptAlternates: ["How is your day going?"],
    workspaceKind: "blank",
  },
  {
    description: "Context Tree workspace with a software engineering prompt.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "tree-software-trigger",
    prompt: "For this project, what constraints should JWT auth routes follow?",
    promptAlternates: ["Analyze server route naming and multi-org permission boundaries for this project."],
    workspaceKind: "context-tree",
  },
  {
    description: "Context Tree workspace with a non-software prompt.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: false,
    id: "tree-nonsoftware-no-trigger",
    prompt: "Recommend a weekend cooking menu.",
    promptAlternates: ["Write a short poem about summer."],
    workspaceKind: "context-tree",
  },
];

export function findFirstTreeReadCase(id: string): FirstTreeReadEvalCase | null {
  for (const evalCase of FIRST_TREE_READ_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}
