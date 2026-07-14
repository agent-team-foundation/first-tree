import type { GitlabEventCard, NormalizedScmEvent, ScmIngressContext } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/connection.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { BadRequestError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import { buildClaimReadyGitlabDeliveryId } from "./gitlab-connections.js";
import { type GitlabEntityIdentity, observeGitlabEntityAndResolveFollowers } from "./gitlab-entity-follow.js";
import { type DeferredScmCardPostCommitEffects, sendScmSystemCard } from "./scm-card-delivery.js";

const log = createLogger("GitlabWebhook");

type JsonObject = Record<string, unknown>;

export type NormalizedGitlabWebhook = {
  ingress: ScmIngressContext;
  event: NormalizedScmEvent | null;
  entityIdentity: GitlabEntityIdentity | null;
  reviewerCapability: "reviewers" | "missing" | "not_applicable";
};

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestError(`${label} must be an object`);
  return value as JsonObject;
}

function requiredString(value: unknown, label: string, maxLength = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new BadRequestError(`${label} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function optionalString(value: unknown, maxLength = 100_000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength)
    throw new BadRequestError("GitLab string field is invalid");
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestError(`${label} must be a positive integer`);
  }
  return value;
}

function gitlabUrl(value: unknown, instanceOrigin: string, label: string): string {
  const raw = requiredString(value, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError(`${label} must be a URL`);
  }
  if (url.origin !== instanceOrigin || url.username || url.password) {
    throw new BadRequestError(`${label} must use the connection's GitLab origin`);
  }
  return url.toString();
}

function actionKind(action: string | null, fallback: NormalizedScmEvent["kind"]): NormalizedScmEvent["kind"] {
  switch (action) {
    case "open":
      return "opened";
    case "close":
      return "closed";
    case "reopen":
      return "reopened";
    case "merge":
      return "merged";
    case "update":
      return "edited";
    default:
      return fallback;
  }
}

export function extractStableGitlabDeliveryId(headers: Record<string, unknown>, connectionId: string): string | null {
  const raw = headers["idempotency-key"] ?? headers["x-gitlab-webhook-uuid"];
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 256 || /[^\x21-\x7e]/.test(raw)) {
    throw new BadRequestError("GitLab stable delivery id header is invalid");
  }
  return buildClaimReadyGitlabDeliveryId(connectionId, raw);
}

export function normalizeGitlabWebhook(input: {
  organizationId: string;
  connectionId: string;
  instanceOrigin: string;
  stableDeliveryId: string | null;
  eventHeader: string;
  body: unknown;
}): NormalizedGitlabWebhook {
  const payload = object(input.body, "GitLab webhook body");
  const objectKind = requiredString(payload.object_kind, "object_kind");
  const expectedKind: Record<string, string> = {
    "Merge Request Hook": "merge_request",
    "Issue Hook": "issue",
    "Note Hook": "note",
    "Test Hook": "test",
  };
  const expected = expectedKind[input.eventHeader];
  if (expected && objectKind !== expected) throw new BadRequestError("X-Gitlab-Event does not match object_kind");
  const ingress: ScmIngressContext = {
    provider: "gitlab",
    source: { organizationId: input.organizationId, externalId: input.connectionId },
    stableDeliveryId: input.stableDeliveryId,
    ingressAuthority: "url_bearer",
  };
  if (!expected || expected === "test") {
    return { ingress, event: null, entityIdentity: null, reviewerCapability: "not_applicable" };
  }

  const project = object(payload.project, "project");
  const projectId = positiveInteger(project.id, "project.id");
  const projectPath = requiredString(project.path_with_namespace, "project.path_with_namespace", 1024);
  const projectUrl = gitlabUrl(project.web_url, input.instanceOrigin, "project.web_url");
  const user = object(payload.user, "user");
  const username = requiredString(user.username ?? user.name, "user.username", 255);
  let attrs: JsonObject;
  let entityType: "issue" | "pull_request";
  let eventType: string;
  let kind: NormalizedScmEvent["kind"];
  let reviewerCapability: NormalizedGitlabWebhook["reviewerCapability"] = "not_applicable";
  let noteBody: string | undefined;

  if (expected === "merge_request") {
    attrs = object(payload.object_attributes, "object_attributes");
    entityType = "pull_request";
    eventType = "merge_request";
    if ("reviewers" in payload && !Array.isArray(payload.reviewers)) {
      throw new BadRequestError("reviewers must be an array when present");
    }
    reviewerCapability = "reviewers" in payload ? "reviewers" : "missing";
    kind = actionKind(optionalString(attrs.action) ?? null, "other");
  } else if (expected === "issue") {
    attrs = object(payload.object_attributes, "object_attributes");
    entityType = "issue";
    eventType = "issue";
    kind = actionKind(optionalString(attrs.action) ?? null, "other");
  } else {
    attrs = object(payload.object_attributes, "object_attributes");
    const noteableType = requiredString(attrs.noteable_type, "object_attributes.noteable_type");
    if (noteableType !== "MergeRequest" && noteableType !== "Issue") {
      return { ingress, event: null, entityIdentity: null, reviewerCapability: "not_applicable" };
    }
    const noteAttrs = attrs;
    noteBody = optionalString(noteAttrs.note) ?? "";
    const parent = object(noteableType === "MergeRequest" ? payload.merge_request : payload.issue, noteableType);
    attrs = { ...parent, url: parent.url ?? noteAttrs.url, action: noteAttrs.action };
    entityType = noteableType === "MergeRequest" ? "pull_request" : "issue";
    eventType = "note";
    kind = optionalString(attrs.action) === "update" ? "edited" : "commented";
  }

  const iid = positiveInteger(attrs.iid, "entity iid");
  const title = optionalString(attrs.title, 1000) ?? "";
  const description = noteBody ?? optionalString(attrs.description) ?? "";
  const action = optionalString(attrs.action, 100) ?? null;
  const fallbackUrl = `${projectUrl.replace(/\/$/, "")}/-/${entityType === "issue" ? "issues" : "merge_requests"}/${iid}`;
  const url = gitlabUrl(optionalString(attrs.url) ?? fallbackUrl, input.instanceOrigin, "entity url");
  const rawState = optionalString(attrs.state, 100);
  const state =
    kind === "merged" || rawState === "merged"
      ? "merged"
      : kind === "closed" || rawState === "closed"
        ? "closed"
        : "open";
  const entityIdentity: GitlabEntityIdentity = {
    entityType,
    entityIid: iid,
    projectId,
    projectPath,
    entityUrl: url,
    title: title || null,
    entityState: state,
  };
  const event: NormalizedScmEvent = {
    ...ingress,
    eventType,
    action,
    entity: {
      type: entityType,
      projectKey: String(projectId),
      key: `${projectId}:${entityType}:${iid}`,
      ...(title ? { title } : {}),
      url,
    },
    actor: { externalUsername: username, isBot: false },
    kind,
    targets: [],
    surface: { title, body: description, url },
    relatedRefs: [],
  };
  return { ingress, event, entityIdentity, reviewerCapability };
}

export async function observeGitlabReviewerCapability(
  db: Database,
  connectionId: string,
  capability: NormalizedGitlabWebhook["reviewerCapability"],
): Promise<void> {
  if (capability === "reviewers") {
    await db
      .update(gitlabConnections)
      .set({ reviewerMode: "reviewers", updatedAt: new Date() })
      .where(and(eq(gitlabConnections.id, connectionId), eq(gitlabConnections.active, true)));
  } else if (capability === "missing") {
    log.info(
      { connectionId, capability: "reviewers_missing" },
      "GitLab MR payload did not declare reviewer capability",
    );
  }
}

export async function resolveGitlabBasicAudience(
  db: Database,
  organizationId: string,
  connectionId: string,
  identity: GitlabEntityIdentity,
) {
  const rows = await observeGitlabEntityAndResolveFollowers(db, organizationId, connectionId, identity);
  const byChat = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!byChat.has(row.chatId)) byChat.set(row.chatId, row);
  return { targets: [...byChat.values()], actorHumanId: null };
}

export async function deliverGitlabBasicCards(
  app: FastifyInstance,
  event: NormalizedScmEvent,
  identity: GitlabEntityIdentity,
  audience: { targets: Array<{ chatId: string; declaredByAgentId: string }> },
  database: Database = app.db,
) {
  if (event.entity.type !== "issue" && event.entity.type !== "pull_request") {
    throw new Error(`Unsupported GitLab card entity type: ${event.entity.type}`);
  }
  const stats: { delivered: number; failed: number; postCommitEffects: DeferredScmCardPostCommitEffects[] } = {
    delivered: 0,
    failed: 0,
    postCommitEffects: [],
  };
  const card: GitlabEventCard = {
    type: "gitlab_event",
    event: event.eventType,
    action: event.action,
    kind: event.kind,
    project: identity.projectPath,
    sender: event.actor.externalUsername,
    title: event.surface.title,
    body: event.surface.body,
    url: event.surface.url,
    entity: { type: event.entity.type, key: event.entity.key, url: event.entity.url ?? null },
  };
  for (const target of audience.targets) {
    try {
      const sent = await sendScmSystemCard(app, {
        chatId: target.chatId,
        senderId: target.declaredByAgentId,
        provider: "gitlab",
        content: card,
        metadata: {
          event: event.eventType,
          action: event.action,
          entityType: event.entity.type,
          entityKey: event.entity.key,
        },
        database,
        deferPostCommitEffects: true,
      });
      if (!sent.deferredPostCommitEffects) {
        throw new Error("GitLab card delivery did not defer post-commit effects");
      }
      stats.postCommitEffects.push(sent.deferredPostCommitEffects);
      stats.delivered += 1;
    } catch (err) {
      stats.failed += 1;
      log.error(
        { err, metric: "gitlab_delivery_failed_total", chatId: target.chatId, entityKey: event.entity.key },
        "failed to deliver normalized GitLab event to chat",
      );
    }
  }
  return stats;
}
