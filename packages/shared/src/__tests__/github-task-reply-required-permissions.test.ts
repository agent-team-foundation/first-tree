import { describe, expect, it } from "vitest";
import { GITHUB_TASK_REPLY_REQUIRED_PERMISSIONS, githubPermissionSatisfies } from "../schemas/github-app.js";

describe("GITHUB_TASK_REPLY_REQUIRED_PERMISSIONS", () => {
  it("is the set the task-reply gate enforces", () => {
    // Both the server's `taskReplyInstallationBlocker` and the Settings →
    // GitHub readout derive from this. Changing it changes what an admin is
    // told AND what the server will publish, so it is pinned here.
    expect(GITHUB_TASK_REPLY_REQUIRED_PERMISSIONS).toEqual({ issues: "write", pull_requests: "write" });
  });
});

describe("githubPermissionSatisfies", () => {
  it("accepts an exact match", () => {
    expect(githubPermissionSatisfies("write", "write")).toBe(true);
    expect(githubPermissionSatisfies("read", "read")).toBe(true);
  });

  it("rejects a weaker grant", () => {
    expect(githubPermissionSatisfies("read", "write")).toBe(false);
    expect(githubPermissionSatisfies("write", "admin")).toBe(false);
  });

  it("does NOT rank levels — a stronger grant is not a substitute", () => {
    // Every other installation-permission check in the server compares levels
    // exactly. Ranking here would let this readout and the task-agent gate
    // accept a grant that `github-audience` / the publishers then reject.
    expect(githubPermissionSatisfies("admin", "write")).toBe(false);
    expect(githubPermissionSatisfies("write", "read")).toBe(false);
  });

  it("treats an absent permission as unsatisfied", () => {
    expect(githubPermissionSatisfies(undefined, "read")).toBe(false);
  });
});
