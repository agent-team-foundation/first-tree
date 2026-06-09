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

    expect(message).toContain("create a brand-new Context Tree");
    expect(message).toContain("Source repo: https://github.com/acme/app");
    expect(message).toContain("Host the new tree as its own GitHub repo under the same owner as the source");
    expect(message).toContain("record its URL in First Tree");

    // Pin out the retired-skill name so the prose can never silently
    // regress to advertising a skill that does not exist on disk.
    expect(message).not.toContain("first-tree onboarding flow");

    // Pin out `$first-tree-seed` naming until the Cloud-side new-tree
    // provisioning step lands. Naming the skill while Cloud still passes
    // `contextTreeUrl: null` would send the kickoff agent to a self-check
    // that hard-refuses on the missing workspace.json tree binding. See
    // the JSDoc on `buildCreateBootstrap` for the full rationale.
    expect(message).not.toContain("$first-tree-seed");
    expect(message).not.toContain("first-tree-seed");
  });

  it("builds plural new-tree instructions", () => {
    const message = buildCreateBootstrap(["https://github.com/acme/web", "https://github.com/acme/api"]);

    expect(message).toContain("one shared Context Tree");
    expect(message).toContain("Source repos:");
    expect(message).toContain("ask me which owner if they don't share one");
    expect(message).toContain("each PR");

    // Same retired / not-yet-wired skill-name pins as the singular case.
    expect(message).not.toContain("first-tree onboarding flow");
    expect(message).not.toContain("$first-tree-seed");
    expect(message).not.toContain("first-tree-seed");
  });
});
