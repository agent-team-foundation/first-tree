import type { SkillEvalSuiteDefinition } from "../core/coverage.js";
import { FIRST_TREE_READ_SUITE } from "./first-tree-read/eval-cases.js";
import { FIRST_TREE_SEED_SUITE } from "./first-tree-seed/cases.js";
import { FIRST_TREE_WELCOME_SUITE } from "./first-tree-welcome/cases.js";
import { FIRST_TREE_WRITE_SUITE } from "./first-tree-write/cases.js";

export const SKILL_EVAL_SUITES: readonly SkillEvalSuiteDefinition[] = [
  FIRST_TREE_READ_SUITE,
  FIRST_TREE_WRITE_SUITE,
  FIRST_TREE_SEED_SUITE,
  FIRST_TREE_WELCOME_SUITE,
];
