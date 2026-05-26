import { z } from "zod";

export const SKILL_SOURCES = {
  BUILTIN: "builtin",
  USER: "user",
  PROJECT: "project",
  PLUGIN: "plugin",
} as const;

export const skillSourceSchema = z.enum(["builtin", "user", "project", "plugin"]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

/**
 * Charset for skill `name` / `namespace`. Must match the composer's
 * `detectSlashTrigger` accept-set (`[A-Za-z0-9_-]`); otherwise a SKILL.md
 * that declared `name: "weird thing"` would be uploadable but unreachable
 * — the user would type `/weird` and the popover would close at the
 * space. Keeping schema = composer accept-set makes the contract
 * single-source.
 */
export const SKILL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Descriptor for a single agent skill (a.k.a. slash command) discovered by
 * the client. Mirrors the YAML frontmatter of a `SKILL.md` file plus a
 * source tag so the web UI can group / annotate. The recipe is intentionally
 * minimal — the agent runtime owns execution; this row only carries what
 * the UI needs to render the slash-command popover.
 */
export const skillDescriptorSchema = z.object({
  /** Skill name without leading slash. e.g. "review", "ship". */
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(SKILL_NAME_REGEX, "Must start with alphanumeric and contain only [A-Za-z0-9_-]."),
  /** Optional plugin namespace; rendered as `<namespace>:<name>`. */
  namespace: z
    .string()
    .max(120)
    .regex(SKILL_NAME_REGEX, "Must start with alphanumeric and contain only [A-Za-z0-9_-].")
    .optional(),
  /** One-line description used as the popover subtitle. */
  description: z.string().max(2000),
  /** Where this skill came from — used for grouping/labelling in the UI. */
  source: skillSourceSchema,
});
export type SkillDescriptor = z.infer<typeof skillDescriptorSchema>;

export const agentSkillsSchema = z.array(skillDescriptorSchema).max(2000);
export type AgentSkills = z.infer<typeof agentSkillsSchema>;

export const updateAgentSkillsSchema = z.object({
  skills: agentSkillsSchema,
});
export type UpdateAgentSkills = z.infer<typeof updateAgentSkillsSchema>;
