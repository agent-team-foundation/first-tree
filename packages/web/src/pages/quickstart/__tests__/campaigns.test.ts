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
    expect(getCampaign("production-scan")?.topic).toBe("Production readiness scan");
    expect(getCampaign("agent-readiness")?.slug).toBe("agent-readiness");
    expect(getCampaign("agent-readiness")?.topic).toBe("Agent readiness scan");
    expect(getCampaign("unknown")).toBeNull();
    expect(getCampaign(null)).toBeNull();
  });

  it("defaults the agent name to a neutral, non-task-bound name (Cedar)", () => {
    expect(QUICKSTART_AGENT_NAME).toBe("Cedar");
  });
});

describe("campaign bootstrap — visible task brief for both user and agent", () => {
  const repoUrl = "https://github.com/acme/backend";

  it("production-scan naturally asks for a production readiness scan", () => {
    const cfg = getCampaign("production-scan");
    if (!cfg) throw new Error("expected production-scan config");
    const bootstrap = cfg.buildBootstrap({ agentDisplayName: QUICKSTART_AGENT_NAME, repoUrl });

    expect(bootstrap).toBe(
      [
        "Cedar, welcome aboard.",
        "",
        "Please run a production readiness scan on this repo:",
        "- https://github.com/acme/backend",
      ].join("\n"),
    );
    const lower = bootstrap.toLowerCase();
    expect(lower).not.toContain("skill");
    expect(lower).not.toContain("first-tree-welcome");
    expect(lower).not.toContain("production-scan");
    expect(lower).not.toContain("rubric");
    expect(lower).not.toContain("bootstrap");
  });

  it("agent-readiness naturally asks for a coding-agent readiness check", () => {
    const cfg = getCampaign("agent-readiness");
    if (!cfg) throw new Error("expected agent-readiness config");
    const bootstrap = cfg.buildBootstrap({ agentDisplayName: "Cedar", repoUrl });

    expect(bootstrap).toBe(
      [
        "Cedar, welcome aboard.",
        "",
        "Please check how ready this repo is for coding agents:",
        "- https://github.com/acme/backend",
      ].join("\n"),
    );
    expect(bootstrap.toLowerCase()).not.toContain("skill");
    expect(bootstrap).not.toContain("agent-readiness");
  });

  it("falls back gracefully when no repo is provided", () => {
    const cfg = getCampaign("production-scan");
    if (!cfg) throw new Error("expected production-scan config");
    const bootstrap = cfg.buildBootstrap({ agentDisplayName: "Cedar", repoUrl: null });
    expect(bootstrap).toContain("Cedar");
    expect(bootstrap.length).toBeGreaterThan(0);
  });
});
