import type { Repo } from "#src/repo.js";
import * as agentInstructions from "#src/rules/agent-instructions.js";
import * as agentIntegration from "#src/rules/agent-integration.js";
import * as ciValidation from "#src/rules/ci-validation.js";
import * as framework from "#src/rules/framework.js";
import * as members from "#src/rules/members.js";
import * as populateTree from "#src/rules/populate-tree.js";
import * as rootNode from "#src/rules/root-node.js";

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
