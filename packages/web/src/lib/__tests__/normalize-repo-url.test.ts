import { describe, expect, it } from "vitest";
import { normalizeRepoUrl } from "../normalize-repo-url.js";

describe("normalizeRepoUrl", () => {
  it("leaves full URLs and scp-like forms unchanged", () => {
    for (const u of [
      "https://github.com/acme/web",
      "https://github.com/acme/web.git",
      "ssh://git@github.com/acme/web.git",
      "git@github.com:acme/web.git",
      "git@github.com:acme/web",
    ]) {
      expect(normalizeRepoUrl(u)).toBe(u);
    }
  });

  it("prepends https:// to a scheme-less host path", () => {
    expect(normalizeRepoUrl("github.com/acme/web")).toBe("https://github.com/acme/web");
    expect(normalizeRepoUrl("github.com/acme/web.git")).toBe("https://github.com/acme/web.git");
    expect(normalizeRepoUrl("gitlab.com/acme/web")).toBe("https://gitlab.com/acme/web");
  });

  it("expands owner/repo shorthand to a GitHub URL", () => {
    expect(normalizeRepoUrl("acme/web")).toBe("https://github.com/acme/web");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRepoUrl("  acme/web  ")).toBe("https://github.com/acme/web");
  });

  it("leaves empty and unrecognized input for schema validation to reject", () => {
    expect(normalizeRepoUrl("")).toBe("");
    expect(normalizeRepoUrl("   ")).toBe("");
    expect(normalizeRepoUrl("not a url")).toBe("not a url");
  });
});
