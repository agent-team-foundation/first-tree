import type { Repo } from "../repo.js";
import * as agentInstructions from "./agent-instructions.js";
import * as agentIntegration from "./agent-integration.js";
import * as ciValidation from "./ci-validation.js";
import * as framework from "./framework.js";
import * as members from "./members.js";
import * as rootNode from "./root-node.js";

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

export { framework, rootNode, agentInstructions, members, agentIntegration, ciValidation };
