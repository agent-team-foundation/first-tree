// @vitest-environment node

import { describe, expect, it } from "vitest";
import { CAMPAIGN_SLUGS } from "../campaigns.js";
import { getScanSkill, SCAN_SKILLS } from "../scan-skills.js";

describe("scan skills", () => {
  it("covers every campaign with a name matching its slug + a real body", () => {
    for (const slug of CAMPAIGN_SLUGS) {
      const skill = getScanSkill(slug);
      expect(skill.name).toBe(slug);
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.body.length).toBeGreaterThan(200);
    }
  });

  it("loads the rubric body via ?raw — schema marker present, frontmatter stripped", () => {
    expect(SCAN_SKILLS["production-scan"].body).toContain("# Production Readiness Scan");
    expect(SCAN_SKILLS["production-scan"].body).toContain("ps-1");
    expect(SCAN_SKILLS["agent-readiness"].body).toContain("# Agent Readiness Scan");
    expect(SCAN_SKILLS["agent-readiness"].body).toContain("ar-1");
    // Body only — the runtime materializer re-adds the YAML frontmatter from
    // name/description, so the .md files must NOT start with a `---` block.
    expect(SCAN_SKILLS["production-scan"].body.startsWith("---")).toBe(false);
  });
});
