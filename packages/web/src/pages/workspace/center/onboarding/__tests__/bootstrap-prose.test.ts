import { describe, expect, it } from "vitest";
import { buildBindBootstrap, buildCreateBootstrap, FIRST_TREE_REFERENCE_URL } from "../bootstrap-prose.js";

describe("kickoff bootstrap prose", () => {
  it("builds singular existing-tree instructions", () => {
    const message = buildBindBootstrap(["https://github.com/acme/app"], "https://github.com/acme/context");

    expect(message).toContain("source repo");
    expect(message).toContain("Source repo: https://github.com/acme/app");
    expect(message).toContain("Existing tree: https://github.com/acme/context");
    expect(message).toContain("bind the repo to that existing tree");
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
    expect(message).toContain("bind every repo to that existing tree");
  });

  it("builds singular new-tree instructions", () => {
    const message = buildCreateBootstrap(["https://github.com/acme/app"]);

    // Opener frames the user's outcome — tree already provisioned by Cloud,
    // agent just seeds it. The "we've just provisioned" phrasing pins the
    // pre-condition that first-tree-seed assumes (tree repo + workspace
    // binding exist before kickoff).
    expect(message).toContain("brand-new Context Tree");
    expect(message).toContain("we've just provisioned");
    expect(message).toContain("Source repo: https://github.com/acme/app");

    // Skill is named so the kickoff agent loads first-tree-seed.
    expect(message).toContain("Run $first-tree-seed");
    // Pre-condition is restated in the skill line so the agent does not try
    // to bind / host / record-URL — first-tree-seed's "What This Skill Does
    // NOT Do" explicitly forbids those.
    expect(message).toContain("tree repo and workspace binding are already in place");

    // Walkthrough mentions both PR1 (structure) and PR2 (content).
    expect(message).toContain("PR1");
    expect(message).toContain("PR2");

    // Forbidden phrasing — these used to live in the old onboarding-skill
    // prose and contradicted first-tree-seed's non-goals. Pin them out so
    // a future edit cannot regress.
    expect(message).not.toContain("Host the new tree");
    expect(message).not.toContain("record its URL");
    expect(message).not.toContain("first-tree onboarding flow");
  });

  it("builds plural new-tree instructions", () => {
    const message = buildCreateBootstrap(["https://github.com/acme/web", "https://github.com/acme/api"]);

    expect(message).toContain("one shared Context Tree");
    expect(message).toContain("we've just provisioned");
    expect(message).toContain("Source repos:");
    expect(message).toContain("- https://github.com/acme/web");
    expect(message).toContain("- https://github.com/acme/api");

    // Each PR still gets a walkthrough mention in the plural variant.
    expect(message).toContain("each PR");

    // Same forbidden-phrasing pins as the singular case.
    expect(message).not.toContain("Host the new tree");
    expect(message).not.toContain("record its URL");
    expect(message).not.toContain("ask me which owner");
  });
});
