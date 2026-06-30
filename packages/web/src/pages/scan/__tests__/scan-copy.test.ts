import { describe, expect, it } from "vitest";
import { CAMPAIGN_SLUGS } from "../../quickstart/campaigns.js";
import { SCAN_LANDING_COPY } from "../scan-copy.js";

describe("scan landing copy", () => {
  it("covers every campaign slug — a new campaign without landing copy is a build error", () => {
    for (const slug of CAMPAIGN_SLUGS) {
      expect(SCAN_LANDING_COPY[slug], `missing landing copy for ${slug}`).toBeTruthy();
    }
    // No stray entries for retired/unknown slugs.
    expect(Object.keys(SCAN_LANDING_COPY).sort()).toEqual([...CAMPAIGN_SLUGS].sort());
  });

  it("every entry has the non-empty fields the page renders", () => {
    for (const slug of CAMPAIGN_SLUGS) {
      const copy = SCAN_LANDING_COPY[slug];
      expect(copy.eyebrow.length).toBeGreaterThan(0);
      expect(copy.headline.length).toBeGreaterThan(0);
      expect(copy.subhead.length).toBeGreaterThan(0);
      expect(copy.ctaLabel.length).toBeGreaterThan(0);
      expect(copy.repoPlaceholder.length).toBeGreaterThan(0);
      expect(copy.checksLabel.length).toBeGreaterThan(0);
      expect(copy.checks.length).toBeGreaterThan(0);
      expect(copy.checks.every((c) => c.trim().length > 0)).toBe(true);
    }
  });

  it("stays honest and restrained — no unsubstantiated superlatives the scan can't back up", () => {
    const banned = ["#1", "best ", "guaranteed", "world's", "no.1", "number one"];
    for (const slug of CAMPAIGN_SLUGS) {
      const copy = SCAN_LANDING_COPY[slug];
      const blob = `${copy.eyebrow} ${copy.headline} ${copy.subhead}`.toLowerCase();
      for (const term of banned) {
        expect(blob, `${slug} copy should avoid "${term.trim()}"`).not.toContain(term);
      }
    }
  });
});
