import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/connection.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabIdentityLinks } from "../db/schema/gitlab-identity-links.js";
import { lockGitlabIdentityAuthoritySet, resolveActiveGitlabIdentity } from "./gitlab-identities.js";
import { runDeferredSendMessageSessionEffects } from "./message.js";
import type { DeferredScmCardPostCommitEffects } from "./scm-card-delivery.js";

export type GitlabIdentityAuthorityProof = {
  identityLinkId: string;
  humanAgentId: string;
  delegateAgentId: string;
};

export type DeferredGitlabCardPostCommitEffects = {
  effects: DeferredScmCardPostCommitEffects;
  authority: {
    organizationId: string;
    connectionId: string;
    tokenHash: string;
    identities: GitlabIdentityAuthorityProof[];
  };
};

/**
 * Re-enter the GitLab authority fence before waking recipients for an already
 * durable card. The external effects run while the second fence is held, so a
 * lifecycle revocation either commits first and suppresses them, or waits
 * until the effects have completed.
 */
export async function runDeferredGitlabCardPostCommitEffects(
  app: FastifyInstance,
  deferred: DeferredGitlabCardPostCommitEffects,
): Promise<boolean> {
  return app.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const { authority } = deferred;
    const [connection] = await tx
      .select({
        id: gitlabConnections.id,
        tokenHash: gitlabConnections.tokenHash,
        automaticActionsEnabled: gitlabConnections.automaticActionsEnabled,
      })
      .from(gitlabConnections)
      .where(
        and(
          eq(gitlabConnections.id, authority.connectionId),
          eq(gitlabConnections.organizationId, authority.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!connection || connection.tokenHash !== authority.tokenHash) return false;

    const proofs = new Map<string, GitlabIdentityAuthorityProof>();
    for (const proof of authority.identities) {
      const existing = proofs.get(proof.identityLinkId);
      if (
        existing &&
        (existing.humanAgentId !== proof.humanAgentId || existing.delegateAgentId !== proof.delegateAgentId)
      ) {
        return false;
      }
      proofs.set(proof.identityLinkId, proof);
    }
    if (proofs.size > 0 && !connection.automaticActionsEnabled) return false;

    const identityLinkIds = [...proofs.keys()].sort();
    if (identityLinkIds.length > 0) {
      await lockGitlabIdentityAuthoritySet(tx, {
        organizationId: authority.organizationId,
        connectionId: authority.connectionId,
        normalizedUsernames: [],
        identityLinkIds,
      });
      const links = await tx
        .select({ id: gitlabIdentityLinks.id, normalizedUsername: gitlabIdentityLinks.normalizedUsername })
        .from(gitlabIdentityLinks)
        .where(
          and(
            eq(gitlabIdentityLinks.organizationId, authority.organizationId),
            eq(gitlabIdentityLinks.connectionId, authority.connectionId),
            eq(gitlabIdentityLinks.state, "active"),
            inArray(gitlabIdentityLinks.id, identityLinkIds),
          ),
        );
      if (links.length !== identityLinkIds.length) return false;
      const usernames = new Map(links.map((link) => [link.id, link.normalizedUsername]));
      const orderedProofs = [...proofs.values()].sort(
        (a, b) =>
          a.humanAgentId.localeCompare(b.humanAgentId) ||
          a.delegateAgentId.localeCompare(b.delegateAgentId) ||
          a.identityLinkId.localeCompare(b.identityLinkId),
      );
      for (const proof of orderedProofs) {
        const normalizedUsername = usernames.get(proof.identityLinkId);
        if (!normalizedUsername) return false;
        const resolved = await resolveActiveGitlabIdentity(tx, {
          organizationId: authority.organizationId,
          connectionId: authority.connectionId,
          normalizedUsername,
          lockForUpdate: true,
        });
        if (
          resolved.outcome !== "ok" ||
          resolved.identity.linkId !== proof.identityLinkId ||
          resolved.identity.humanAgentId !== proof.humanAgentId ||
          resolved.identity.delegateAgentId !== proof.delegateAgentId
        ) {
          return false;
        }
      }
    }

    await runDeferredSendMessageSessionEffects(tx, deferred.effects.messageEffects);
    await Promise.allSettled([
      app.notifier.notifyChatMessage(deferred.effects.messageEffects.chatId, deferred.effects.messageId),
      ...deferred.effects.recipients.map((inboxId) => app.notifier.notify(inboxId, deferred.effects.messageId)),
    ]);
    return true;
  });
}
