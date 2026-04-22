import { describe, expect, it } from "vitest";

import {
  parseAllowRepoArg,
  requireExplicitRepoFilter,
} from "../../src/products/breeze/engine/runtime/allow-repo.js";

describe("parseAllowRepoArg", () => {
  it("reads both spaced and equals forms", () => {
    expect(parseAllowRepoArg(["--allow-repo", "owner/repo"])).toBe("owner/repo");
    expect(parseAllowRepoArg(["--allow-repo=owner/*"])).toBe("owner/*");
  });
});

describe("requireExplicitRepoFilter", () => {
  it("rejects missing and effectively empty repo scopes", () => {
    expect(() => requireExplicitRepoFilter(undefined)).toThrow(
      /missing required --allow-repo/u,
    );
    expect(() => requireExplicitRepoFilter(",")).toThrow(
      /missing required --allow-repo/u,
    );
  });

  it("parses exact repos and owner globs", () => {
    const filter = requireExplicitRepoFilter("owner/repo,team/*");
    expect(filter.matchesRepo("owner/repo")).toBe(true);
    expect(filter.matchesRepo("team/project")).toBe(true);
    expect(filter.matchesRepo("other/project")).toBe(false);
  });
});
