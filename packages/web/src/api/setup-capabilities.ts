import { type TeamSetupCapabilities, teamSetupCapabilitiesSchema } from "@first-tree/shared";
import { api, withOrgAt } from "./client.js";

export const setupCapabilitiesQueryKey = (organizationId: string | null) =>
  ["setup-capabilities", organizationId] as const;

/**
 * Read the selected Team's role-independent Setup projection.
 *
 * Runtime parsing keeps a malformed capability response from being rendered as
 * readiness. The explicit organization check is a second fail-closed guard
 * against a stale or incorrectly scoped response after a Team switch.
 */
export async function getTeamSetupCapabilitiesAt(organizationId: string): Promise<TeamSetupCapabilities> {
  const parsed = teamSetupCapabilitiesSchema.parse(
    await api.get<unknown>(withOrgAt(organizationId, "/setup-capabilities")),
  );
  if (parsed.organizationId !== organizationId) {
    throw new Error("Setup capabilities response did not match the requested organization");
  }
  return parsed;
}
