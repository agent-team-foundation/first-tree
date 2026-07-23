import {
  type ContextReviewerCandidatesOutput,
  contextReviewerCandidatesOutputSchema,
  type OrgContextTreeFeaturesOutput,
  orgContextTreeFeaturesOutputSchema,
} from "@first-tree/shared";
import { api } from "./client.js";

function path(organizationId: string, operation: string): string {
  return `/orgs/${encodeURIComponent(organizationId)}/context-reviewer/${operation}`;
}

export async function getContextReviewerCandidates(organizationId: string): Promise<ContextReviewerCandidatesOutput> {
  return contextReviewerCandidatesOutputSchema.parse(await api.get<unknown>(path(organizationId, "candidates")));
}

export async function putContextReviewerAssignment(
  organizationId: string,
  agentUuid: string | null,
): Promise<OrgContextTreeFeaturesOutput> {
  return orgContextTreeFeaturesOutputSchema.parse(
    await api.put<unknown>(path(organizationId, "assignment"), { agentUuid }),
  );
}

export async function putContextReviewerEnablement(
  organizationId: string,
  enabled: boolean,
): Promise<OrgContextTreeFeaturesOutput> {
  return orgContextTreeFeaturesOutputSchema.parse(
    await api.put<unknown>(path(organizationId, "enablement"), { enabled }),
  );
}
