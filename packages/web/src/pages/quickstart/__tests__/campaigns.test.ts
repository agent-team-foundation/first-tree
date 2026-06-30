import { describe, expect, it } from "vitest";
import { getCampaign, isKnownCampaign, QUICKSTART_AGENT_NAME } from "../campaigns.js";

describe("campaign registry", () => {
  it("knows the v0 campaigns and rejects everything else", () => {
    expect(isKnownCampaign("production-scan")).toBe(true);
    expect(isKnownCampaign("agent-readiness")).toBe(true);
    expect(isKnownCampaign("nope")).toBe(false);
    expect(isKnownCampaign(null)).toBe(false);
    expect(isKnownCampaign("")).toBe(false);
  });

  it("getCampaign returns the config for a known slug, null otherwise", () => {
    expect(getCampaign("production-scan")?.slug).toBe("production-scan");
    expect(getCampaign("agent-readiness")?.slug).toBe("agent-readiness");
    expect(getCampaign("unknown")).toBeNull();
    expect(getCampaign(null)).toBeNull();
  });

  it("defaults the agent name to a neutral, non-task-bound name (Cedar)", () => {
    expect(QUICKSTART_AGENT_NAME).toBe("Cedar");
  });
});

describe("campaign bootstrap — dual-reader: shown verbatim to the user, so clean welcome copy only", () => {
  const repoUrl = "https://github.com/acme/backend";

  it("production-scan names the agent + repo and carries no skill/operational jargon", () => {
    const cfg = getCampaign("production-scan");
    if (!cfg) throw new Error("expected production-scan config");
    const bootstrap = cfg.buildBootstrap({ agentDisplayName: QUICKSTART_AGENT_NAME, repoUrl });

    expect(bootstrap).toContain("Cedar");
    expect(bootstrap).toContain("github.com/acme/backend");
    // The bootstrap renders verbatim as the user's first chat bubble (see
    // system/cloud/onboarding.md "dual-reader"), so it must not leak agent-only
    // activation jargon — that travels in message metadata, never the body.
    const lower = bootstrap.toLowerCase();
    expect(lower).not.toContain("skill");
    expect(lower).not.toContain("first-tree-welcome");
    expect(lower).not.toContain("rubric");
    expect(lower).not.toContain("bootstrap");
  });

  it("agent-readiness has its own framing but stays equally clean", () => {
    const cfg = getCampaign("agent-readiness");
    if (!cfg) throw new Error("expected agent-readiness config");
    const bootstrap = cfg.buildBootstrap({ agentDisplayName: "Cedar", repoUrl });

    expect(bootstrap).toContain("Cedar");
    expect(bootstrap).toContain("github.com/acme/backend");
    expect(bootstrap.toLowerCase()).not.toContain("skill");
  });

  it("falls back gracefully when no repo is provided", () => {
    const cfg = getCampaign("production-scan");
    if (!cfg) throw new Error("expected production-scan config");
    const bootstrap = cfg.buildBootstrap({ agentDisplayName: "Cedar", repoUrl: null });
    expect(bootstrap).toContain("Cedar");
    expect(bootstrap.length).toBeGreaterThan(0);
  });
});
