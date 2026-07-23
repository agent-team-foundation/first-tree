import { describe, expect, it } from "vitest";
import {
  GITLAB_CONNECTION_READINESS,
  gitlabConnectionPollingInterval,
  gitlabConnectionReadiness,
} from "../gitlab-connection-readiness.js";

function connection(input: {
  lastValidInboundAt?: string | null;
  lastSystemHookMergeRequestInboundAt?: string | null;
  lastProcessingFailureAt?: string | null;
}) {
  return {
    health: {
      lastValidInboundAt: input.lastValidInboundAt ?? null,
      lastSystemHookMergeRequestInboundAt: input.lastSystemHookMergeRequestInboundAt ?? null,
      lastProcessingFailureAt: input.lastProcessingFailureAt ?? null,
    },
  };
}

describe("GitLab connection readiness", () => {
  it("separates transport receipt from System Hook MR routing evidence", () => {
    expect(gitlabConnectionReadiness(connection({}))).toBe(GITLAB_CONNECTION_READINESS.waiting);
    expect(gitlabConnectionReadiness(connection({ lastValidInboundAt: "2026-07-23T08:00:00.000Z" }))).toBe(
      GITLAB_CONNECTION_READINESS.transportReceived,
    );
    expect(
      gitlabConnectionReadiness(
        connection({
          lastValidInboundAt: "2026-07-23T08:00:00.000Z",
          lastSystemHookMergeRequestInboundAt: "2026-07-23T08:01:00.000Z",
        }),
      ),
    ).toBe(GITLAB_CONNECTION_READINESS.routingVerified);
  });

  it("gives a same-time or newer processing failure precedence over MR receipt", () => {
    expect(
      gitlabConnectionReadiness(
        connection({
          lastValidInboundAt: "2026-07-23T08:00:00.000Z",
          lastSystemHookMergeRequestInboundAt: "2026-07-23T08:01:00.000Z",
          lastProcessingFailureAt: "2026-07-23T08:01:00.000Z",
        }),
      ),
    ).toBe(GITLAB_CONNECTION_READINESS.needsAttention);
  });

  it("returns to verified only when MR evidence is newer than the failure", () => {
    expect(
      gitlabConnectionReadiness(
        connection({
          lastValidInboundAt: "2026-07-23T08:02:00.000Z",
          lastSystemHookMergeRequestInboundAt: "2026-07-23T08:02:00.000Z",
          lastProcessingFailureAt: "2026-07-23T08:01:00.000Z",
        }),
      ),
    ).toBe(GITLAB_CONNECTION_READINESS.routingVerified);
  });
});

describe("GitLab connection polling", () => {
  it("keeps recovery status live without polling an empty connection list", () => {
    expect(gitlabConnectionPollingInterval({ hasOneTimeSecret: true, connectionCount: 0 })).toBe(4_000);
    expect(gitlabConnectionPollingInterval({ hasOneTimeSecret: false, connectionCount: 1 })).toBe(15_000);
    expect(gitlabConnectionPollingInterval({ hasOneTimeSecret: false, connectionCount: 0 })).toBe(false);
  });
});
