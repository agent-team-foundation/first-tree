import { describe, expect, it } from "vitest";
import {
  buildInviteeReadyBootstrap,
  buildNoRepoBootstrap,
  buildTreeSetupBootstrap,
  buildValueFirstBootstrap,
} from "../bootstrap-prose.js";

describe("kickoff bootstrap prose", () => {
  it("builds a first-task kickoff that explains the chat before the operational note", () => {
    const message = buildValueFirstBootstrap(["https://github.com/acme/app"], {
      agentDisplayName: "Nova",
      treeSetup: "pending",
    });

    expect(message).toContain("This is your first task chat with Nova.");
    expect(message).toContain("Connected code:");
    expect(message).toContain("https://github.com/acme/app");
    expect(message).toContain("Nova will first read the available code and team context");
    expect(message).toContain("then suggest a few small tasks you can start with");
    expect(message).toContain("Operational note: use the first-tree-welcome skill");
    expect(message).toContain("Keep team context setup in the separate setup chat");
    expect(message).not.toContain("First Tree is getting");
    expect(message).not.toContain("Start with useful work");
    expect(message).not.toContain("First response requirements:");
    expect(message).not.toContain("evidence-backed");
    expect(message).not.toContain("2–3");
    expect(message).not.toContain("tracked request primitive");
    expect(message).not.toContain("chat ask");
    expect(message).not.toContain("Skip for now");
    expect(message).not.toContain("My team's Context Tree");
    expect(message).not.toContain("Build tree");
  });

  it("builds a slim no-repo kickoff that asks for code without authorization-first setup", () => {
    const message = buildNoRepoBootstrap("Nova");

    expect(message).toContain("This is your first chat with Nova.");
    expect(message).toContain("No code is connected yet.");
    expect(message).toContain("local folder path or a GitHub repo URL");
    expect(message).toContain("Keep setup light");
    expect(message).toContain("show value from real code first");
    expect(message).toContain("Operational note: use the first-tree-welcome skill");
    expect(message).not.toContain("First Tree is introducing");
    expect(message).not.toContain("First response requirements:");
    expect(message).not.toContain("tracked request primitive");
    expect(message).not.toContain("chat ask");
    expect(message).not.toContain("2–3");
    expect(message).not.toContain("Skip for now");
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

  it("builds a slim value-first joining-teammate invitee message", () => {
    const message = buildInviteeReadyBootstrap("Nova", "https://github.com/acme/context");

    expect(message).toContain("This is your first task chat with Nova.");
    expect(message).toContain("Team context: https://github.com/acme/context");
    expect(message).toContain("Nova will use the team's code and context");
    expect(message).toContain("suggest a few small tasks you can start with");
    expect(message).toContain("Operational note: use the first-tree-welcome skill");
    expect(message).toContain("Do not make team context setup the invitee's first task");
    expect(message).not.toContain("First Tree is getting");
    expect(message).not.toContain("Start with useful work");
    expect(message).not.toContain("First response requirements:");
    expect(message).not.toContain("2–3");
    expect(message).not.toContain("tracked request primitive");
    expect(message).not.toContain("chat ask");
    // A brand-new teammate is NOT asked to write to the tree or seed it, and the
    // admin's "my repos are now connected" voice must not leak in.
    expect(message).not.toContain("first-tree-seed");
    expect(message).not.toContain("reflect them into the tree");
    expect(message).not.toContain("are now connected");
  });
});
