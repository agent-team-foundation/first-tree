import { describe, expect, it } from "vitest";
import { getCampaign } from "../../../../quickstart/campaigns.js";
import {
  buildCampaignActionBootstrap,
  buildInviteeReadyBootstrap,
  buildNoRepoBootstrap,
  buildScanFixBootstrap,
  buildValueFirstBootstrap,
} from "../bootstrap-prose.js";

// These kickoff bodies are rendered verbatim to the user and delivered to the
// agent unchanged. They must be short public task briefs: natural enough for the
// user, and clear enough for skill routing without naming internal skills.
describe("start-chat bootstrap prose", () => {
  it("builds a value-first first chat that uses a natural public ask", () => {
    const message = buildValueFirstBootstrap(["https://github.com/acme/app"], {
      agentDisplayName: "Nova",
      treeSetup: "pending",
    });

    expect(message).toContain("Nova, welcome aboard.");
    expect(message).toContain("Please help me get started with First Tree.");
    expect(message).toContain("Connected code:");
    expect(message).toContain("https://github.com/acme/app");
    expect(message).not.toContain("Operational note");
    expect(message).not.toContain("first-tree-welcome");
    expect(message).not.toContain("Ask me for a local folder path or GitHub URL");
    expect(message).not.toContain("host gh");
    expect(message).not.toContain("First response requirements:");
    expect(message).not.toContain("Skip for now");
  });

  it("keeps the same short first-chat ask when a bound tree is available", () => {
    const none = buildValueFirstBootstrap(["https://github.com/acme/app"], {
      agentDisplayName: "Nova",
      treeSetup: "none",
    });
    expect(none).not.toContain("shared context");

    const bound = buildValueFirstBootstrap(["https://github.com/acme/app"], {
      agentDisplayName: "Nova",
      treeSetup: "bound",
    });
    expect(bound).toBe(
      [
        "Nova, welcome aboard.",
        "",
        "Please help me get started with First Tree.",
        "",
        "Connected code:",
        "- https://github.com/acme/app",
      ].join("\n"),
    );
  });

  it("builds a no-repo first chat that does not ask for project details in the visible brief", () => {
    const message = buildNoRepoBootstrap("Nova");

    expect(message).toBe(["Nova, welcome aboard.", "", "Please help me get started with First Tree."].join("\n"));
    expect(message).not.toContain("Operational note");
    expect(message).not.toContain("first-tree-welcome");
    expect(message).not.toContain("Ask me for a local folder path or GitHub URL");
    expect(message).not.toContain("Ask the user for the project");
    expect(message).not.toContain("host gh");
  });

  it("builds a value-first joining-teammate welcome without a raw tree URL or jargon", () => {
    const message = buildInviteeReadyBootstrap("Nova");

    expect(message).toBe(
      ["Nova, welcome aboard.", "", "Please help me get settled into this team on First Tree."].join("\n"),
    );
    expect(message).not.toContain("Operational note");
    expect(message).not.toContain("first-tree-welcome");
    expect(message).not.toContain("Team context:");
    // A brand-new teammate is NOT asked to write to or seed the tree.
    expect(message).not.toContain("first-tree-seed");
    expect(message).not.toContain("reflect them into the tree");
  });
});

describe("buildCampaignActionBootstrap for agent-readiness", () => {
  it("carries the atr-1 report into a review-first direct task", () => {
    const campaign = getCampaign("agent-readiness");
    if (!campaign) throw new Error("agent-readiness campaign config is missing");

    const message = buildCampaignActionBootstrap(
      "Dev",
      campaign.action,
      {
        repoUrl: "https://github.com/octo/app",
        reportKey: "octo-app-20260716-ab12cd34",
      },
      "direct",
    );

    expect(message).toContain("apply the prioritized fixes from my Agent Team Readiness report");
    expect(message).toContain(
      "Machine-readable findings: https://report.first-tree.ai/octo-app-20260716-ab12cd34.json",
    );
    expect(message).toContain("verify that its repository.source normalizes to the requested repository URL");
    expect(message).toContain("Keep any AGENTS.md or Context Tree change review-first and source-backed");
    expect(message).not.toContain("welcome aboard");
  });
});

describe("buildScanFixBootstrap", () => {
  const handoff = {
    repoUrl: "https://github.com/octo/app",
    reportKey: "octo-app-20260707-ab12cd3",
  };

  it("includes repo, hosted report, and findings JSON URLs", () => {
    const s = buildScanFixBootstrap("Dev", handoff);
    expect(s).toContain("Repository: https://github.com/octo/app");
    expect(s).toContain("https://report.first-tree.ai/octo-app-20260707-ab12cd3.html");
    expect(s).toContain("Machine-readable findings: https://report.first-tree.ai/octo-app-20260707-ab12cd3.json");
    expect(s).toContain("production readiness scan");
  });

  it("degrades without a report key: no report URLs, asks to re-run or share", () => {
    const s = buildScanFixBootstrap("Dev", { ...handoff, reportKey: null });
    expect(s).not.toContain("report.first-tree.ai");
    expect(s).toContain("Repository: https://github.com/octo/app");
    expect(s).toContain("re-run the scan");
  });

  it("direct opening drops the onboarding greeting but keeps the recognition phrase", () => {
    const s = buildScanFixBootstrap("Dev", handoff, "direct");
    expect(s).not.toContain("welcome aboard");
    expect(s).toContain("Dev, please help me fix the launch blockers found by my production readiness scan.");
    expect(s).toContain("Repository: https://github.com/octo/app");
    expect(s).toContain("Machine-readable findings: https://report.first-tree.ai/octo-app-20260707-ab12cd3.json");
  });
});
