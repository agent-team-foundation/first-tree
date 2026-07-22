import { describe, expect, it } from "vitest";
import { gitlabEntityLinkPresentation } from "../gitlab-entity-link.js";

describe("gitlabEntityLinkPresentation", () => {
  it.each([
    ["https://gitlab.example/acme/web/-/merge_requests/25", "acme/web!25"],
    ["https://gitlab.example/acme/web/merge_requests/25", "acme/web!25"],
    ["https://gitlab.example/acme/web/-/issues/7", "acme/web#7"],
    ["https://gitlab.example/acme/web/issues/7", "acme/web#7"],
  ])("formats %s", (href, label) => {
    expect(gitlabEntityLinkPresentation(href, "https://gitlab.example")).toEqual({ label, title: href });
  });

  it("decodes the visible project path while preserving the original href as its title", () => {
    const href = "https://gitlab.example/acme/design%20system/-/merge_requests/3";
    expect(gitlabEntityLinkPresentation(href, "https://gitlab.example")).toEqual({
      label: "acme/design system!3",
      title: href,
    });
  });

  it.each([
    ["https://other.example/acme/web/-/merge_requests/25", "https://gitlab.example"],
    ["https://gitlab.example/acme/web/-/pipelines/25", "https://gitlab.example"],
    ["https://gitlab.example/acme/web/-/issues/7?tab=notes", "https://gitlab.example"],
    ["not a URL", "https://gitlab.example"],
    ["https://gitlab.example/acme/web/-/issues/7", null],
  ])("does not format untrusted or unsupported input %s", (href, origin) => {
    expect(gitlabEntityLinkPresentation(href, origin)).toBeNull();
  });
});
