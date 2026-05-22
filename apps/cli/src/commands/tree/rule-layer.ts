import { join } from "node:path";

import { readCurrentCliVersion } from "./cli-version.js";
import type { TemplateWriteResult } from "./template-write.js";
import { writeTemplatedFile } from "./template-write.js";
import {
  renderAutoMergeWorkflow,
  renderReviewEnforcerWorkflow,
  renderValidateWorkflow,
} from "./tree-templates.js";

export const VALIDATE_WORKFLOW_TEMPLATE_VERSION = 2;
export const AUTO_MERGE_WORKFLOW_TEMPLATE_VERSION = 1;
export const REVIEW_ENFORCER_WORKFLOW_TEMPLATE_VERSION = 1;

export type Tier0RuleLayerSummary = {
  validate: TemplateWriteResult;
};

export type Tier2RuleLayerSummary = {
  autoMerge: TemplateWriteResult;
  reviewEnforcer: TemplateWriteResult;
};

export function validateWorkflowPath(targetRoot: string): string {
  return join(targetRoot, ".github", "workflows", "validate.yml");
}

export function autoMergeWorkflowPath(targetRoot: string): string {
  return join(targetRoot, ".github", "workflows", "auto-merge.yml");
}

export function reviewEnforcerWorkflowPath(targetRoot: string): string {
  return join(targetRoot, ".github", "workflows", "review-enforcer.yml");
}

export function ensureTier0RuleLayer(targetRoot: string): Tier0RuleLayerSummary {
  return {
    validate: writeTemplatedFile(
      validateWorkflowPath(targetRoot),
      renderValidateWorkflow(readCurrentCliVersion()),
      {
        version: VALIDATE_WORKFLOW_TEMPLATE_VERSION,
      },
    ),
  };
}

export function ensureTier2RuleLayer(targetRoot: string): Tier2RuleLayerSummary {
  return {
    autoMerge: writeTemplatedFile(autoMergeWorkflowPath(targetRoot), renderAutoMergeWorkflow(), {
      version: AUTO_MERGE_WORKFLOW_TEMPLATE_VERSION,
    }),
    reviewEnforcer: writeTemplatedFile(
      reviewEnforcerWorkflowPath(targetRoot),
      renderReviewEnforcerWorkflow(),
      {
        version: REVIEW_ENFORCER_WORKFLOW_TEMPLATE_VERSION,
      },
    ),
  };
}
