import type { OnboardingState } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

/**
 * Persist the wizard checkpoint for the current member. Server validates
 * the JSONB shape against `onboardingStateSchema`; bad input throws an
 * `ApiError(400)`. The caller doesn't get a response body — `204 No
 * Content` on success.
 */
export async function setOnboardingState(state: OnboardingState): Promise<void> {
  await api.patch("/me/onboarding-state", state);
}

export type CreateAgentRequest = {
  name: string;
  displayName: string;
  type: "autonomous_agent" | "personal_assistant";
  /** Required so the new agent runs on the user's connected machine. */
  clientId: string;
};

export type CreateAgentResponse = {
  uuid: string;
  name: string;
  displayName: string;
};

/** Wraps `POST /admin/agents`. Wizard-side helper to keep the call site small. */
export async function createWizardAgent(input: CreateAgentRequest): Promise<CreateAgentResponse> {
  return api.post("/admin/agents/", input);
}
