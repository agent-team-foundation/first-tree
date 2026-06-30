import { describe, expect, it } from "vitest";
import {
  buildInviteeReadyBootstrap,
  buildNoRepoBootstrap,
  buildTreeSetupBootstrap,
  buildValueFirstBootstrap,
} from "../bootstrap-prose.js";

// These kickoff bodies are rendered verbatim to the user as a "First Tree"
// chat bubble (the first thing a new user sees), so they must read as a plain
// user welcome. The reliable first-tree-welcome activation is appended for the
// agent client-side (see packages/client agent-io `onboardingSkillDirective`),
// so the bubble itself carries no skill name or operational note.
describe("start-chat bootstrap prose", () => {
  it("builds a value-first first chat that reads as a user welcome, not an operational note", () => {
    const message = buildValueFirstBootstrap(["https://github.com/acme/app"], {
      agentDisplayName: "Nova",
      treeSetup: "pending",
    });

    expect(message).toContain("Welcome to First Tree — this is your first chat with Nova.");
    expect(message).toContain("It's already connected to your code:");
    expect(message).toContain("https://github.com/acme/app");
    expect(message).toContain("Nova will get oriented and then suggest a few small tasks you could start with");
    expect(message).toContain("or just tell it what you have in mind");
    expect(message).not.toContain("Operational note");
    expect(message).not.toContain("first-tree-welcome");
    expect(message).not.toContain("host gh");
    expect(message).not.toContain("First response requirements:");
    expect(message).not.toContain("Skip for now");
  });

  it("mentions team context only when a bound tree is available", () => {
    const none = buildValueFirstBootstrap(["https://github.com/acme/app"], {
      agentDisplayName: "Nova",
      treeSetup: "none",
    });
    expect(none).not.toContain("shared context");

    const bound = buildValueFirstBootstrap(["https://github.com/acme/app"], {
      agentDisplayName: "Nova",
      treeSetup: "bound",
    });
    expect(bound).toContain("Nova can also draw on your team's shared context");
  });

  it("builds a no-repo first chat that asks for a project as a user welcome", () => {
    const message = buildNoRepoBootstrap("Nova");

    expect(message).toContain("Welcome to First Tree — this is your first chat with Nova.");
    expect(message).toContain("point it at a folder on your computer or paste a GitHub URL");
    expect(message).not.toContain("Operational note");
    expect(message).not.toContain("first-tree-welcome");
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
    expect(message).toContain("Operational note: after reading the bound tree");
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

  it("builds a value-first joining-teammate welcome without a raw tree URL or jargon", () => {
    const message = buildInviteeReadyBootstrap("Nova");

    expect(message).toContain("Welcome to First Tree — this is your first chat with Nova.");
    expect(message).toContain("Your team's shared context is already set up");
    expect(message).toContain("Nova can get oriented from the team's work");
    expect(message).toContain("Tell it what you'd like to dig into");
    expect(message).not.toContain("Operational note");
    expect(message).not.toContain("first-tree-welcome");
    expect(message).not.toContain("Team context:");
    // A brand-new teammate is NOT asked to write to or seed the tree.
    expect(message).not.toContain("first-tree-seed");
    expect(message).not.toContain("reflect them into the tree");
  });
});
