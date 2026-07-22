import {
  createKeyedTaskChatSchema,
  createMeChatSchema,
  createWebTaskChatSchema,
  listMeChatSourceCountsQuerySchema,
  listMeChatsQuerySchema,
  paginationQuerySchema,
} from "@first-tree/shared";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { chats } from "../../db/schema/chats.js";
import { BadRequestError, ForbiddenError } from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import { assertAllAgentsVisibleInOrg } from "../../scope/require-resource.js";
import { createChat, listChatsForMember, resolveAgentIdsByNameInOrg } from "../../services/chat.js";
import {
  reconcileContextReviewTaskReuse,
  resolveContextReviewTaskAuthority,
} from "../../services/context-review-task.js";
import { assertNoLandingCampaignTrialAgents } from "../../services/landing-campaigns/guards.js";
import { createMeChat, listMeChatSourceCounts, listMeChats } from "../../services/me-chat.js";
import { notifyRecipients } from "../../services/notifier.js";
import {
  campaignActionKickoffKey,
  recordCampaignActionConversion,
  resolveCampaignActionContext,
} from "../../services/onboarding-kickoff.js";
import { configuredAvatarAuthorityTag } from "../../utils/server-authority.js";

/**
 * Class B — org-scoped chat collection routes. Mounted at
 * `/api/v1/orgs/:orgId/chats`.
 *
 * Replaces both `/admin/chats` (admin audit view) and `/me/chats`
 * (member workspace view) — visibility is decided by `role`:
 *
 *   - `GET ?scope=mine`        → my workspace conversations (default)
 *   - `GET ?scope=all`         → admin-only audit list
 *   - `POST /`                 → create a chat (creator = caller's HUMAN)
 *   - `POST /:chatId/...`      → see api/chats.ts (Class C)
 */
export async function orgChatRoutes(app: FastifyInstance): Promise<void> {
  const avatarAuthorityTag = configuredAvatarAuthorityTag(app.config);
  /**
   * GET /orgs/:orgId/chats — workspace list by default; pass `scope=all`
   * for the admin audit view (returns 403 for non-admins).
   */
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const rawQuery = request.query as Record<string, string | undefined>;
    const view = rawQuery.scope ?? "mine";

    if (view === "all") {
      if (scope.role !== "admin") {
        throw new ForbiddenError("Admin role required for org-wide chat list");
      }
      const query = paginationQuerySchema.parse(request.query);
      const conditions = [eq(chats.organizationId, scope.organizationId)];
      if (query.cursor) conditions.push(lt(chats.createdAt, new Date(query.cursor)));

      const rows = await app.db
        .select({
          id: chats.id,
          organizationId: chats.organizationId,
          type: chats.type,
          topic: chats.topic,
          lifecyclePolicy: chats.lifecyclePolicy,
          metadata: chats.metadata,
          createdAt: chats.createdAt,
          updatedAt: chats.updatedAt,
          participantCount: sql<number>`(
            SELECT count(*)::int FROM chat_membership WHERE chat_id = ${chats.id} AND access_mode = 'speaker'
          )`,
        })
        .from(chats)
        .where(and(...conditions))
        .orderBy(desc(chats.createdAt))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

      return {
        items: items.map((c) => ({
          id: c.id,
          organizationId: c.organizationId,
          type: c.type,
          topic: c.topic,
          lifecyclePolicy: c.lifecyclePolicy,
          metadata: c.metadata,
          participantCount: c.participantCount,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        })),
        nextCursor,
      };
    }

    if (view === "grouped") {
      // Member-scoped chat listing grouped by agent. Returns chats where
      // the member's agents participate or are supervised (managed).
      return listChatsForMember(app.db, scope.memberId, scope.humanAgentId);
    }

    // Default: workspace conversation list for the caller's HUMAN agent.
    const query = listMeChatsQuerySchema.parse(request.query);
    return listMeChats(app.db, scope.humanAgentId, scope.memberId, scope.organizationId, query, avatarAuthorityTag);
  });

  /**
   * GET /orgs/:orgId/chats/source-counts — per-source aggregate powering the
   * conversation-list tag bar (Manual / GitHub / Agent).
   * Returns counts only for sources the caller has chats in, plus an
   * always-present `manual` entry. Same engagement view filter as the list.
   */
  app.get<{ Params: { orgId: string } }>("/source-counts", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const query = listMeChatSourceCountsQuerySchema.parse(request.query);
    return listMeChatSourceCounts(app.db, scope.humanAgentId, scope.organizationId, query);
  });

  const createChatRouteOptions = {
    // `undefined` intentionally preserves @fastify/rate-limit's global shared
    // bucket while exposing that policy to CodeQL's Fastify route model.
    config: { otelRecordBody: false, rateLimit: undefined },
  };

  /**
   * POST /orgs/:orgId/chats — create a new chat. The :orgId path param
   * makes the org explicit; visibility of every requested participant is
   * verified before the service layer touches the DB.
   *
   * Rate limiting is the global actor-aware `@fastify/rate-limit` guard
   * registered in `app.ts`; this authenticated route intentionally does not
   * duplicate the shared safety policy with a lower per-route cap.
   */
  app.post<{ Params: { orgId: string } }>("/", createChatRouteOptions, async (request, reply) => {
    const scope = await requireOrgMembership(request, app.db);
    const rawBody = request.body;
    if (rawBody !== null && typeof rawBody === "object" && "mode" in rawBody && rawBody.mode === "keyed_task") {
      const body = createKeyedTaskChatSchema.parse(rawBody);
      const authority = await resolveContextReviewTaskAuthority(app.db, {
        organizationId: scope.organizationId,
        requester: {
          userId: scope.userId,
          memberId: scope.memberId,
          humanAgentUuid: scope.humanAgentId,
        },
        metadata: body.initialMessage.metadata,
      });
      const result = await createChat(app.db, {
        mode: "task",
        initiatorAgentId: scope.humanAgentId,
        organizationId: scope.organizationId,
        initialRecipientAgentIds: [authority.reviewerAgentUuid],
        contextParticipantAgentIds: [],
        topic: authority.topic,
        onboardingKickoffKey: authority.reservationKey,
        initialMessage: {
          format: "markdown",
          content: body.initialMessage.content,
          metadata: body.initialMessage.metadata,
          source: "api",
        },
        source: "manual",
        allowContextReviewRun: true,
        beforeTaskResult: async (tx) => {
          await resolveContextReviewTaskAuthority(tx, {
            organizationId: scope.organizationId,
            requester: {
              userId: scope.userId,
              memberId: scope.memberId,
              humanAgentUuid: scope.humanAgentId,
            },
            metadata: body.initialMessage.metadata,
            expectedReviewerAgentUuid: authority.reviewerAgentUuid,
            lock: true,
          });
        },
        onTaskReuse: async (tx, context) =>
          reconcileContextReviewTaskReuse(tx, {
            ...context,
            organizationId: scope.organizationId,
            requesterAgentUuid: scope.humanAgentId,
            authority,
            metadata: body.initialMessage.metadata,
          }),
      });

      if (result.notificationMessageId) {
        notifyRecipients(app.notifier, result.recipients, result.notificationMessageId);
      }
      return reply.status(result.initialMessageCreated ? 201 : 200).send({
        chatId: result.chat.id,
        messageId: result.message.id,
        topic: result.chat.topic,
        effectiveSenderId: result.effectiveSenderId,
        reviewerAgentUuid: authority.reviewerAgentUuid,
        outcome: result.initialMessageCreated ? "created" : "reused",
      });
    }
    if (rawBody !== null && typeof rawBody === "object" && "mode" in rawBody) {
      const body = createWebTaskChatSchema.parse(rawBody);
      const initialRecipientAgentIds = [
        ...body.initialRecipientAgentIds,
        ...(await resolveAgentIdsByNameInOrg(app.db, scope.organizationId, body.initialRecipientNames)),
      ];
      const contextParticipantAgentIds = [
        ...body.contextParticipantAgentIds,
        ...(await resolveAgentIdsByNameInOrg(app.db, scope.organizationId, body.contextParticipantNames)),
      ];
      const visibleTargetIds = [...new Set([...initialRecipientAgentIds, ...contextParticipantAgentIds])].filter(
        (id) => id !== scope.humanAgentId,
      );
      await assertAllAgentsVisibleInOrg(app.db, scope, visibleTargetIds);
      await assertNoLandingCampaignTrialAgents(app.db, visibleTargetIds);
      const campaignAction = resolveCampaignActionContext(body.campaignAction, body.scanFixRepoSlug);
      const result = await createChat(app.db, {
        mode: "task",
        initiatorAgentId: scope.humanAgentId,
        organizationId: scope.organizationId,
        initialRecipientAgentIds,
        contextParticipantAgentIds,
        topic: body.topic ?? null,
        description: body.description ?? null,
        initialMessage: { ...body.initialMessage, source: "web" },
        source: "manual",
        // Campaign actions share one key across direct and onboarding paths.
        ...(campaignAction
          ? { onboardingKickoffKey: campaignActionKickoffKey(scope.humanAgentId, campaignAction) }
          : {}),
      });
      if (campaignAction) {
        try {
          await recordCampaignActionConversion(app.db, {
            humanAgentId: scope.humanAgentId,
            organizationId: scope.organizationId,
            action: campaignAction,
            actionChatId: result.chat.id,
          });
        } catch (err) {
          app.log.warn(
            { err, campaign: campaignAction.campaign, actionChatId: result.chat.id },
            "landing campaign action conversion could not be recorded",
          );
        }
      }
      notifyRecipients(app.notifier, result.recipients, result.message.id);
      return reply.status(201).send({
        chatId: result.chat.id,
        messageId: result.message.id,
        topic: result.chat.topic,
        effectiveSenderId: result.effectiveSenderId,
        initialRecipientAgentIds: result.initialRecipientAgentIds,
        contextParticipantAgentIds: result.contextParticipantAgentIds,
      });
    }

    const body = createMeChatSchema.parse(rawBody);
    const targetIds = [...new Set(body.participantIds)].filter((id) => id !== scope.humanAgentId);
    if (targetIds.length === 0) {
      // Service layer also enforces this (services/me-chat.ts), but bail at
      // the handler so the visibility query below isn't run on an empty list.
      throw new BadRequestError("At least one non-self participant required");
    }
    await assertAllAgentsVisibleInOrg(app.db, scope, targetIds);
    await assertNoLandingCampaignTrialAgents(app.db, targetIds);

    const result = await createMeChat(app.db, scope.humanAgentId, scope.organizationId, body);
    return reply.status(201).send(result);
  });
}
