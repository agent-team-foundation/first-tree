/**
 * Phase-dependent defaults that flip with release milestones. Kept as a plain
 * module-level constant so reviews of the beta→GA transition are a one-line
 * diff, and so tests can mock this module to exercise both branches.
 */

export const UPDATE_POLICIES = ["auto", "prompt", "off"] as const;
export type UpdatePolicy = (typeof UPDATE_POLICIES)[number];

/**
 * Default value of `update.policy` on the Client config. During the beta this
 * is `"auto"` — operators rarely know to `npm i -g` weekly and we chase the
 * latest published Command by default. The GA PR flips it to `"prompt"` and
 * bumps Command to `1.0.0`.
 */
export const UPDATE_POLICY_DEFAULT: UpdatePolicy = "auto";
