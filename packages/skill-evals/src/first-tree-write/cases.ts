import type { FirstTreeWriteEvalCase } from "./types.js";

export const EXPECTED_WRITE_TARGET_PATH = "systems/server/auth/jwt";

const WRITE_PROMPT = `Please capture the following source-backed decision into the Context Tree.

Source note:
JWT route authorization now treats the user JWT as the single authorization
surface for web, CLI, and managed agents. Route handlers must resolve
organization membership live before accepting cross-org actions, because a
stored client or pinned agent relationship is not sufficient authorization.
This belongs with the existing server auth JWT context, not the route naming
conventions node.`;

export const FIRST_TREE_WRITE_CASES: readonly FirstTreeWriteEvalCase[] = [
  {
    description: "Source-backed Context Tree write with first-tree-write installed.",
    expectedTargetPath: EXPECTED_WRITE_TARGET_PATH,
    expectedTrigger: true,
    id: "write-source-trigger",
    installedSkillSet: "write",
    prompt: WRITE_PROMPT,
    promptAlternates: [
      "Record this design note in the tree: user JWT remains the single auth surface and cross-org actions re-check membership live.",
    ],
    workspaceKind: "context-tree",
  },
  {
    description: "Read-only Context Tree lookup with first-tree-write installed.",
    expectedTargetPath: EXPECTED_WRITE_TARGET_PATH,
    expectedTrigger: false,
    id: "read-only-no-write-trigger",
    installedSkillSet: "write",
    prompt:
      "Read the existing Context Tree context and summarize what JWT route authorization constraints already exist. Do not update the tree.",
    promptAlternates: ["What does the current tree say about JWT auth route constraints?"],
    workspaceKind: "context-tree",
  },
  {
    description: "Source-backed Context Tree write with read and write skills installed.",
    expectedTargetPath: EXPECTED_WRITE_TARGET_PATH,
    expectedTrigger: true,
    id: "read-and-write-installed-write-trigger",
    installedSkillSet: "read-write",
    prompt: WRITE_PROMPT,
    promptAlternates: [
      "Use the attached note to update the tree: JWT user auth is the unified authorization surface and route handlers must check live org membership.",
    ],
    workspaceKind: "context-tree",
  },
  {
    description: "Read-only Context Tree lookup with read and write skills installed.",
    expectedTargetPath: EXPECTED_WRITE_TARGET_PATH,
    expectedTrigger: false,
    id: "read-and-write-installed-read-trigger",
    installedSkillSet: "read-write",
    prompt:
      "For this project, read the Context Tree and tell me the existing constraints for JWT auth routes. Do not propose or perform a tree update.",
    promptAlternates: ["Look up current JWT auth route context in the tree without writing anything."],
    workspaceKind: "context-tree",
  },
];

export function findFirstTreeWriteCase(id: string): FirstTreeWriteEvalCase | null {
  for (const evalCase of FIRST_TREE_WRITE_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}
