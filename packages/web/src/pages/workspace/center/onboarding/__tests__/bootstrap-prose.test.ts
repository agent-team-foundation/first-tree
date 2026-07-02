import { describe, expect, it } from "vitest";
import {
  buildInviteeReadyBootstrap,
  buildNoRepoBootstrap,
  buildTreeSetupBootstrap,
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

  it("builds slim tree setup instructions that inspect a bound tree before choosing seed or write", () => {
    const message = buildTreeSetupBootstrap(["https://github.com/acme/app"], {
      treeBindingPlan: "useBoundTree",
      treeUrl: "https://github.com/acme/context",
    });

    expect(message).toContain("This chat sets up team context for future agent work.");
    expect(message).toContain("Source code:");
    expect(message).toContain("- https://github.com/acme/app");
    expect(message).toContain("Context Tree: https://github.com/acme/context");
    expect(message).toContain("This setup helps future agents understand the team's code, decisions, and conventions.");
    expect(message).toContain("The first task chat stays separate.");
    expect(message).toContain("Read the bound tree first.");
    expect(message).toContain("first-tree-seed");
    expect(message).toContain("first-tree-read");
    expect(message).toContain("first-tree-write");
    expect(message).not.toContain("First Tree opened");
    expect(message).not.toContain("First response requirements:");
    expect(message).not.toContain("Do not impersonate");
    expect(message).not.toContain("first-tree-context");
    expect(message).not.toContain("bind the repo to that existing tree");
    expect(message).not.toContain("PR back to the source");
    expect(message).not.toContain("My source repo");
    expect(message).not.toContain("My team's Context Tree");
  });

  it("builds plural create-binding tree setup instructions without a tree URL", () => {
    const message = buildTreeSetupBootstrap(["https://github.com/acme/web", "https://github.com/acme/api"], {
      treeBindingPlan: "createBinding",
      treeUrl: null,
    });

    expect(message).toContain("Source code:");
    expect(message).toContain("- https://github.com/acme/web");
    expect(message).toContain("- https://github.com/acme/api");
    expect(message).toContain("resolved by First Tree Cloud");
    expect(message).toContain("first-tree-seed");
    expect(message).not.toContain("Host the new tree");
    expect(message).not.toContain("record its URL");
    expect(message).not.toContain("create a brand-new Context Tree");
    expect(message).not.toContain("ask me which owner");
  });

  it("builds a tree-less from-zero build message for agentSeed — names no skill, no bound tree", () => {
    const message = buildTreeSetupBootstrap(["https://github.com/acme/web"], {
      treeBindingPlan: "agentSeed",
      treeUrl: null,
    });

    expect(message).toContain("Build our team's Context Tree from our connected code");
    expect(message).toContain("Source code:");
    expect(message).toContain("- https://github.com/acme/web");
    expect(message).toContain("The first task chat stays separate.");
    // Tree-less: no bound-tree line, and the visible task text names no skill —
    // the agent reaches first-tree-seed from its skill map, not the message.
    expect(message).not.toContain("Context Tree:");
    expect(message).not.toContain("resolved by First Tree Cloud");
    expect(message).not.toContain("Read the bound tree first.");
    expect(message).not.toContain("first-tree-seed");
    expect(message).not.toContain("first-tree-read");
    expect(message).not.toContain("first-tree-write");
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
