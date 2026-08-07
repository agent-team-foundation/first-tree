import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type ContextSkillLoadRequest,
  type ContextSkillLoadResponse,
  contextSkillLoadRequestSchema,
  contextSkillLoadResponseSchema,
} from "@first-tree/shared";
import { resolveContextCorePath, resolveContextIntegrationRelease } from "./release.js";

export function loadContextSkill(
  input: ContextSkillLoadRequest,
  options: { releaseRoot?: string; coreRoot?: string } = {},
): ContextSkillLoadResponse {
  const request = contextSkillLoadRequestSchema.parse(input);
  const release = resolveContextIntegrationRelease(options.releaseRoot, {
    coreRoot: options.coreRoot,
    requirePinnedCoreRoot: true,
  });
  const skill = release.manifest.core.skills[request.name];
  const skillPath = resolveContextCorePath(release, skill.path);
  const policyPath = resolveContextCorePath(release, release.manifest.core.policy.path);
  assertDigest(skillPath, skill.digest, request.name);
  assertDigest(policyPath, release.manifest.core.policy.digest, "Context Tree Policy");
  return contextSkillLoadResponseSchema.parse({
    schemaVersion: 1,
    loaderProtocolVersion: 1,
    consumerKind: "byo",
    provider: request.provider,
    releaseVersion: release.manifest.version,
    adapterVersion: release.manifest.providers[request.provider].adapterVersion,
    name: request.name,
    skillPath,
    skillDigest: skill.digest,
    policyPath,
    policyDigest: release.manifest.core.policy.digest,
  });
}

function assertDigest(path: string, expected: string, label: string): void {
  const actual = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  if (actual !== expected) throw new Error(`${label} digest changed after release verification.`);
}
