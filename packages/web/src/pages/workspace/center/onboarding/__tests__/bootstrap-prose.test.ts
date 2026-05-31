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
    expect(message).toContain("record its URL on the Hub");
  });

  it("builds plural new-tree instructions", () => {
    const message = buildCreateBootstrap(["https://github.com/acme/web", "https://github.com/acme/api"]);

    expect(message).toContain("one shared Context Tree");
    expect(message).toContain("Source repos:");
    expect(message).toContain("ask me which owner if they don't share one");
    expect(message).toContain("each PR");
  });
});
