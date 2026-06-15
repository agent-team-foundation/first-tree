import { describe, expect, it } from "vitest";
import {
  buildBindBootstrap,
  buildCreateBootstrap,
  buildInviteeBootstrap,
  FIRST_TREE_REFERENCE_URL,
} from "../bootstrap-prose.js";

describe("kickoff bootstrap prose", () => {
  it("builds singular existing-tree instructions", () => {
    const message = buildBindBootstrap(["https://github.com/acme/app"], "https://github.com/acme/context");

    expect(message).toContain("source repo");
    expect(message).toContain("Source repo: https://github.com/acme/app");
    expect(message).toContain("Existing tree: https://github.com/acme/context");
    // Binding is now written automatically by the runtime (workspace.json), so
    // the agent is told the repo is already connected and pointed at reading /
    // reflecting — never at performing a manual bind + PR-back.
    expect(message).toContain("connected");
    expect(message).toContain("first-tree-write");
    expect(message).not.toContain("bind the repo to that existing tree");
    expect(message).not.toContain("PR back to the source");
    // A populated team tree must never invoke the one-shot seed skill.
    expect(message).not.toContain("first-tree-seed");
    expect(message).toContain(FIRST_TREE_REFERENCE_URL);
  });

  it("builds plural existing-tree instructions", () => {
    const message = buildBindBootstrap(
      ["https://github.com/acme/web", "https://github.com/acme/api"],
      "https://github.com/acme/context",
    );

    expect(message).toContain("source repos");
    expect(message).toContain("Source repos:");
    expect(message).toContain("- https://github.com/acme/web");
    expect(message).toContain("- https://github.com/acme/api");
    expect(message).toContain("Existing tree: https://github.com/acme/context");
    expect(message).toContain("connected");
    expect(message).toContain("first-tree-write");
    expect(message).not.toContain("bind every repo to that existing tree");
  });

  it("builds singular new-tree instructions", () => {
    const message = buildCreateBootstrap(["https://github.com/acme/app"]);

    expect(message).toContain("Source repo: https://github.com/acme/app");
    // Cloud now provisions the tree repo + org binding and the runtime writes
    // workspace.json before this message is sent, so the new-tree prose names
    // `first-tree-seed` directly and tells the agent to seed an already-bound,
    // already-empty tree from the source — it no longer asks the agent to
    // create the GitHub repo or record its URL.
    expect(message).toContain("first-tree-seed");
    expect(message).toContain("not placeholders");

    // Retired skill name must never reappear.
    expect(message).not.toContain("first-tree onboarding flow");
    // The agent no longer self-provisions the tree: Cloud already did.
    expect(message).not.toContain("Host the new tree");
    expect(message).not.toContain("record its URL");
    expect(message).not.toContain("create a brand-new Context Tree");

    expect(message).toContain(FIRST_TREE_REFERENCE_URL);
  });

  it("builds plural new-tree instructions", () => {
    const message = buildCreateBootstrap(["https://github.com/acme/web", "https://github.com/acme/api"]);

    expect(message).toContain("Source repos:");
    expect(message).toContain("- https://github.com/acme/web");
    expect(message).toContain("- https://github.com/acme/api");
    expect(message).toContain("first-tree-seed");
    expect(message).toContain("not placeholders");

    expect(message).not.toContain("first-tree onboarding flow");
    expect(message).not.toContain("Host the new tree");
    expect(message).not.toContain("record its URL");
    // Cloud names + creates the repo, so the agent is never asked which owner.
    expect(message).not.toContain("ask me which owner");
  });

  it("builds a joining-teammate invitee message (orient + introduce, not tree writes)", () => {
    const message = buildInviteeBootstrap("https://github.com/acme/context");

    expect(message).toContain("just joined the team");
    expect(message).toContain("Team Context Tree: https://github.com/acme/context");
    expect(message).toContain("Read the tree first to get oriented");
    expect(message).toContain("introduce yourself");
    expect(message).toContain(FIRST_TREE_REFERENCE_URL);
    // A brand-new teammate is NOT asked to write to the tree or seed it, and the
    // admin's "my repos are now connected" voice must not leak in.
    expect(message).not.toContain("first-tree-seed");
    expect(message).not.toContain("reflect them into the tree");
    expect(message).not.toContain("are now connected");
  });
});
