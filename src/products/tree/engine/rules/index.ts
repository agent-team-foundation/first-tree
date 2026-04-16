import type { Repo } from "#products/tree/engine/repo.js";
import * as agentInstructions from "#products/tree/engine/rules/agent-instructions.js";
import * as agentIntegration from "#products/tree/engine/rules/agent-integration.js";
import * as ciValidation from "#products/tree/engine/rules/ci-validation.js";
import * as framework from "#products/tree/engine/rules/framework.js";
import * as members from "#products/tree/engine/rules/members.js";
import * as populateTree from "#products/tree/engine/rules/populate-tree.js";
import * as rootNode from "#products/tree/engine/rules/root-node.js";

export interface RuleResult {
  group: string;
  order: number;
  tasks: string[];
}

interface Rule {
  evaluate(repo: Repo): RuleResult;
}

const ALL_RULES: Rule[] = [
  framework,
  rootNode,
  agentInstructions,
  members,
  agentIntegration,
  ciValidation,
  populateTree,
];

export function evaluateAll(repo: Repo): RuleResult[] {
  const results: RuleResult[] = [];
  for (const rule of ALL_RULES) {
    const result = rule.evaluate(repo);
    if (result.tasks.length > 0) {
      results.push(result);
    }
  }
  return results.sort((a, b) => a.order - b.order);
}

export { framework, rootNode, agentInstructions, members, agentIntegration, ciValidation, populateTree };
