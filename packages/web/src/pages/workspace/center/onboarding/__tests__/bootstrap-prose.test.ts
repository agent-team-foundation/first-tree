import { describe, expect, it } from "vitest";
import {
  buildInviteeReadyBootstrap,
  buildNoRepoBootstrap,
  buildTreeSetupBootstrap,
  buildValueFirstBootstrap,
  FIRST_TREE_REFERENCE_URL,
} from "../bootstrap-prose.js";

describe("kickoff bootstrap prose", () => {
  it("builds a value-first kickoff that asks for evidence-backed task options before tree work", () => {
    const message = buildValueFirstBootstrap(["https://github.com/acme/app"], {
      agentDisplayName: "Nova",
      treeSetup: "pending",
    });

    expect(message).toContain("First Tree is getting Nova up to speed on https://github.com/acme/app");
    expect(message).toContain("Use the first-tree-welcome skill");
    expect(message).toContain("evidence-backed");
    expect(message).toContain("2–3");
    expect(message).toContain("tracked request primitive");
    expect(message).toContain("chat ask");
    expect(message).not.toContain("Skip for now");
    expect(message).toContain("free-text accepted");
    expect(message).toContain("separate Context Tree setup chat");
    expect(message).not.toContain("My team's Context Tree");
    expect(message).not.toContain("Build tree");
  });

  it("builds a no-repo kickoff that asks for local code before authorization", () => {
    const message = buildNoRepoBootstrap("Nova");

    expect(message).toContain("First Tree is introducing Nova before a repo is connected");
    expect(message).toContain("Use the first-tree-welcome skill");
    expect(message).toContain("local clone path or a GitHub URL");
    expect(message).toContain("before any long-term team setup");
    expect(message).toContain("tracked request primitive");
    expect(message).toContain("chat ask");
    expect(message).not.toContain("Skip for now");
    expect(message).toContain("free-text");
    expect(message).toContain("broad GitHub authorization before the user has seen repo-specific value");
  });

  it("builds tree setup instructions that inspect a bound tree before choosing seed or write", () => {
    const message = buildTreeSetupBootstrap(["https://github.com/acme/app"], {
      treeBindingPlan: "useBoundTree",
      treeUrl: "https://github.com/acme/context",
    });

    expect(message).toContain("separate Context Tree setup chat");
    expect(message).toContain("Source repo: https://github.com/acme/app");
    expect(message).toContain("Bound Context Tree: https://github.com/acme/context");
    expect(message).toContain("existing org Context Tree binding");
    expect(message).toContain("Read the bound Context Tree first");
    expect(message).toContain("If the tree is still empty");
    expect(message).toContain("first-tree-seed");
    expect(message).toContain("first-tree-read");
    expect(message).toContain("first-tree-write");
    expect(message).not.toContain("first-tree-context");
    expect(message).not.toContain("bind the repo to that existing tree");
    expect(message).not.toContain("PR back to the source");
    expect(message).not.toContain("My source repo");
    expect(message).not.toContain("My team's Context Tree");
    expect(message).toContain(FIRST_TREE_REFERENCE_URL);
  });

  it("builds plural create-binding tree setup instructions without a tree URL", () => {
    const message = buildTreeSetupBootstrap(["https://github.com/acme/web", "https://github.com/acme/api"], {
      treeBindingPlan: "createBinding",
      treeUrl: null,
    });

    expect(message).toContain("Source repos:");
    expect(message).toContain("- https://github.com/acme/web");
    expect(message).toContain("- https://github.com/acme/api");
    expect(message).toContain("resolved by First Tree Cloud");
    expect(message).toContain("created or adopted");
    expect(message).toContain("first-tree-seed");
    expect(message).not.toContain("Host the new tree");
    expect(message).not.toContain("record its URL");
    expect(message).not.toContain("create a brand-new Context Tree");
    expect(message).not.toContain("ask me which owner");
  });

  it("builds a value-first joining-teammate invitee message", () => {
    const message = buildInviteeReadyBootstrap("Nova", "https://github.com/acme/context");

    expect(message).toContain("welcoming Nova");
    expect(message).toContain("Use the first-tree-welcome skill");
    expect(message).toContain("Team Context Tree: https://github.com/acme/context");
    expect(message).toContain("Read the team's Context Tree first");
    expect(message).toContain("Briefly introduce");
    expect(message).toContain("2–3");
    expect(message).toContain("format=request");
    expect(message).toContain(FIRST_TREE_REFERENCE_URL);
    // A brand-new teammate is NOT asked to write to the tree or seed it, and the
    // admin's "my repos are now connected" voice must not leak in.
    expect(message).not.toContain("first-tree-seed");
    expect(message).not.toContain("reflect them into the tree");
    expect(message).not.toContain("are now connected");
  });
});
