import { describe, expect, it } from "vitest";
import { gitlabConnectionPollingInterval } from "../gitlab-connection-readiness.js";

describe("GitLab connection polling", () => {
  it("keeps recovery status live without polling an empty connection list", () => {
    expect(gitlabConnectionPollingInterval({ hasOneTimeSecret: true, connectionCount: 0 })).toBe(4_000);
    expect(gitlabConnectionPollingInterval({ hasOneTimeSecret: false, connectionCount: 1 })).toBe(15_000);
    expect(gitlabConnectionPollingInterval({ hasOneTimeSecret: false, connectionCount: 0 })).toBe(false);
  });
});
