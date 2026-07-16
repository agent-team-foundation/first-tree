import type { SkillEvalSuiteDefinition } from "../core/coverage.js";
import { CONTEXT_TREE_AUDIT_SUITE } from "./context-tree-audit/cases.js";
import { CONTEXT_TREE_REVIEW_SUITE } from "./context-tree-review/cases.js";
import { FIRST_TREE_QA_SUITE } from "./first-tree-qa/cases.js";
import { FIRST_TREE_READ_SUITE } from "./first-tree-read/eval-cases.js";
import { FIRST_TREE_SEED_SUITE } from "./first-tree-seed/cases.js";
import { FIRST_TREE_WELCOME_SUITE } from "./first-tree-welcome/cases.js";
import { FIRST_TREE_WRITE_SUITE } from "./first-tree-write/cases.js";

export const SKILL_EVAL_SUITES: readonly SkillEvalSuiteDefinition[] = [
  CONTEXT_TREE_AUDIT_SUITE,
  CONTEXT_TREE_REVIEW_SUITE,
  FIRST_TREE_READ_SUITE,
  FIRST_TREE_QA_SUITE,
  FIRST_TREE_WRITE_SUITE,
  FIRST_TREE_SEED_SUITE,
  FIRST_TREE_WELCOME_SUITE,
];
