export const GITLAB_CONNECTION_READINESS = {
  waiting: "waiting",
  transportReceived: "transport_received",
  routingVerified: "routing_verified",
  needsAttention: "needs_attention",
} as const;

export type GitlabConnectionReadiness = (typeof GITLAB_CONNECTION_READINESS)[keyof typeof GITLAB_CONNECTION_READINESS];

export type GitlabConnectionReadinessInput = {
  health: {
    lastValidInboundAt: string | null;
    lastSystemHookMergeRequestInboundAt: string | null;
    lastProcessingFailureAt: string | null;
  };
};

export function gitlabConnectionPollingInterval(input: {
  hasOneTimeSecret: boolean;
  connectionCount: number;
}): number | false {
  if (input.hasOneTimeSecret) return 4_000;
  return input.connectionCount > 0 ? 15_000 : false;
}

/**
 * Keep every GitLab Settings consumer on the same evidence model.
 *
 * A valid Push, Test, or lifecycle System Hook proves only that the bearer URL
 * was reached. Only a normalized System Hook merge request observation proves
 * the chosen full-instance routing path. A failure at the same timestamp as
 * the latest MR receipt wins so coarse timestamp precision cannot show green.
 */
export function gitlabConnectionReadiness(connection: GitlabConnectionReadinessInput): GitlabConnectionReadiness {
  const failureAt = timestamp(connection.health.lastProcessingFailureAt);
  const routableAt = timestamp(connection.health.lastSystemHookMergeRequestInboundAt);
  if (failureAt !== null && (routableAt === null || failureAt >= routableAt)) {
    return GITLAB_CONNECTION_READINESS.needsAttention;
  }
  if (routableAt !== null) return GITLAB_CONNECTION_READINESS.routingVerified;
  if (connection.health.lastValidInboundAt !== null) return GITLAB_CONNECTION_READINESS.transportReceived;
  return GITLAB_CONNECTION_READINESS.waiting;
}

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
