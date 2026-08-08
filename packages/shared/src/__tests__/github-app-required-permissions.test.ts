import { describe, expect, it } from "vitest";
import { GITHUB_APP_REQUIRED_PERMISSIONS, githubPermissionSatisfies } from "../schemas/github-app.js";

describe("GITHUB_APP_REQUIRED_PERMISSIONS", () => {
  it("is the set the task-reply gate enforces", () => {
    // Both the server's `taskReplyInstallationBlocker` and the Settings →
    // GitHub readout derive from this. Changing it changes what an admin is
    // told AND what the server will publish, so it is pinned here.
    expect(GITHUB_APP_REQUIRED_PERMISSIONS).toEqual({ issues: "write", pull_requests: "write" });
  });
});

describe("githubPermissionSatisfies", () => {
  it("accepts an exact match", () => {
    expect(githubPermissionSatisfies("write", "write")).toBe(true);
    expect(githubPermissionSatisfies("read", "read")).toBe(true);
  });

  it("accepts a stronger grant — GitHub's write implies read", () => {
    expect(githubPermissionSatisfies("write", "read")).toBe(true);
    expect(githubPermissionSatisfies("admin", "write")).toBe(true);
    expect(githubPermissionSatisfies("admin", "read")).toBe(true);
  });

  it("rejects a weaker grant", () => {
    expect(githubPermissionSatisfies("read", "write")).toBe(false);
    expect(githubPermissionSatisfies("write", "admin")).toBe(false);
  });

  it("treats an absent permission as unsatisfied", () => {
    expect(githubPermissionSatisfies(undefined, "read")).toBe(false);
  });
});
