import type { LandingCampaignStartRequest, LandingCampaignStartResponse } from "@first-tree/shared";
import { landingCampaignStartResponseSchema } from "@first-tree/shared";
import { api } from "./client.js";

export async function startLandingCampaign(args: LandingCampaignStartRequest): Promise<LandingCampaignStartResponse> {
  return landingCampaignStartResponseSchema.parse(
    await api.post<LandingCampaignStartResponse>("/me/landing-campaigns/start", args),
  );
}
