import { z } from "zod";

/**
 * Inferred onboarding step returned by `GET /me`. The server derives this
 * from live `clients` / `agents` rows on every request — no persisted
 * `members.onboarding_state` column. The advantage is that deleting the
 * client or the first agent automatically rewinds the wizard, so the UI
 * always reflects truth-on-the-ground rather than a snapshot.
 */
export const wizardStepSchema = z.enum(["connect", "create_agent", "completed"]);
export type WizardStep = z.infer<typeof wizardStepSchema>;

/** Brief org descriptor returned to the wizard / org switcher. */
export const orgBriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  role: z.enum(["admin", "member"]),
});
export type OrgBrief = z.infer<typeof orgBriefSchema>;

/** Body for `POST /me/organizations` — operator wants to create another team. */
export const createOrgFromMeSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().min(1).max(200),
});
export type CreateOrgFromMe = z.infer<typeof createOrgFromMeSchema>;

/** Body for `POST /auth/switch-org`. */
export const switchOrgSchema = z.object({
  organizationId: z.string().min(1),
});
export type SwitchOrg = z.infer<typeof switchOrgSchema>;
