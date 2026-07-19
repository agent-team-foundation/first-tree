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
    readMode: "managed",
    workspaceKind: "blank",
  },
  {
    description: "Context Tree workspace with a software engineering prompt.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "tree-software-trigger",
    prompt: "For this project, what constraints should JWT auth routes follow?",
    promptAlternates: ["Analyze server route naming and multi-org permission boundaries for this project."],
    readMode: "managed",
    workspaceKind: "context-tree",
  },
  {
    description: "Explicit-Team BYO task that must activate one exact read snapshot before discovery.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "byo-explicit-team-trigger",
    prompt:
      "For this BYO Context Tree task, use the explicit First Tree Team id `team-byo-read-eval` and answer: what constraints should JWT auth routes follow?",
    promptAlternates: [
      "Team `team-byo-read-eval` is the explicit target for this BYO task. Read its current Context Tree once, then explain multi-org JWT route constraints.",
    ],
    readMode: "byo",
    workspaceKind: "byo-context-tree",
  },
  {
    description: "Context Tree workspace with a non-software prompt.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: false,
    id: "tree-nonsoftware-no-trigger",
    prompt: "Recommend a weekend cooking menu.",
    promptAlternates: ["Write a short poem about summer."],
    readMode: "managed",
    workspaceKind: "context-tree",
  },
];

export const FIRST_TREE_READ_PERIODIC_CASES: readonly FirstTreeReadEvalCase[] = [
  {
    briefingMode: "runtime-generated",
    description: "Context Tree workspace with runtime-generated briefing and installed First Tree family skills.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "first-tree-read-runtime-generated-briefing-periodic",
    prompt:
      "Use this workspace's current Context Tree to answer: what constraints should JWT auth routes follow for this project?",
    promptAlternates: ["Use the current Context Tree before answering: how should multi-org JWT route scopes work?"],
    readMode: "managed",
    workspaceKind: "context-tree",
  },
];

export function findFirstTreeReadCase(id: string): FirstTreeReadEvalCase | null {
  for (const evalCase of FIRST_TREE_READ_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}

export function findFirstTreeReadPeriodicCase(id: string): FirstTreeReadEvalCase | null {
  for (const evalCase of FIRST_TREE_READ_PERIODIC_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}
