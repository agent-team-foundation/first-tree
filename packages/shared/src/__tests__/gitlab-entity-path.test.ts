import { describe, expect, it } from "vitest";
import { parseGitlabEntityPath } from "../gitlab-entity-path.js";

describe("parseGitlabEntityPath", () => {
  it.each([
    ["/group/project/-/merge_requests/25", "pull_request", "group/project", 25],
    ["/group/project/merge_requests/25", "pull_request", "group/project", 25],
    ["/group/project/-/issues/7", "issue", "group/project", 7],
    ["/group/project/issues/7/", "issue", "group/project", 7],
  ] as const)("parses %s", (pathname, entityType, projectPath, entityIid) => {
    expect(parseGitlabEntityPath(pathname)).toEqual({
      ok: true,
      value: { entityType, projectPath, entityIid },
    });
  });

  it("decodes nested project paths without confusing project-name route segments", () => {
    expect(parseGitlabEntityPath("/group/issues/123/project%20name/-/issues/9")).toEqual({
      ok: true,
      value: { entityType: "issue", projectPath: "group/issues/123/project name", entityIid: 9 },
    });
  });

  it.each([
    ["/group/project/-/pipelines/1", "route"],
    ["/-/issues/1", "route"],
    ["/group/project/-/issues/not-a-number", "route"],
    ["/group/project/-/issues/1//", "route"],
    ["/group/%E0%A4%A/-/issues/1", "encoding"],
    ["/group/%00project/-/issues/1", "control_character"],
    ["/group/project/-/issues/0", "identity"],
    [`/group/project/-/issues/${Number.MAX_SAFE_INTEGER}0`, "identity"],
  ] as const)("rejects %s as %s", (pathname, reason) => {
    expect(parseGitlabEntityPath(pathname)).toEqual({ ok: false, reason });
  });
});
