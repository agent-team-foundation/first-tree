import type {
  GitlabEventCard,
  GitlabReviewerMode,
  GitlabTargetClass,
  InvolveReason,
  NormalizedScmEvent,
  ScmIngressContext,
} from "@first-tree/shared";
import { chatMetadataSchema } from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { gitlabIdentityLinks } from "../db/schema/gitlab-identity-links.js";
import { members } from "../db/schema/members.js";
import { BadRequestError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import { createChat } from "./chat.js";
import { buildClaimReadyGitlabDeliveryId } from "./gitlab-connections.js";
import {
  type GitlabEntityIdentity,
  normalizeGitlabProjectPath,
  observeGitlabEntityAndResolveFollowers,
} from "./gitlab-entity-follow.js";
import {
  lockGitlabIdentityAuthoritySet,
  normalizeGitlabUsername,
  resolveActiveGitlabIdentity,
} from "./gitlab-identities.js";
import type { DeferredGitlabCardPostCommitEffects, GitlabIdentityAuthorityProof } from "./gitlab-post-commit.js";
import { recordGitlabSkippedTarget } from "./gitlab-target-audit.js";
import { type DeferredScmCardPostCommitEffects, sendScmSystemCard } from "./scm-card-delivery.js";
import {
  compareScmDeliveryEntries,
  planScmChatDeliveries,
  type ScmAudienceTarget,
  scmWakeAgentIds,
  selectScmCardContext,
  selectScmSenderId,
} from "./scm-chat-delivery-plan.js";

const log = createLogger("GitlabWebhook");

type JsonObject = Record<string, unknown>;

export const MAX_GITLAB_PERSONNEL_TARGETS = 50;

export class GitlabPersonnelTargetLimitError extends BadRequestError {
  constructor() {
    super(`GitLab webhook personnel targets must not exceed ${MAX_GITLAB_PERSONNEL_TARGETS}`);
  }
}

export type NormalizedGitlabWebhook = {
  ingress: ScmIngressContext;
  event: NormalizedScmEvent | null;
  entityIdentity: GitlabEntityIdentity | null;
  personnel: GitlabPersonnelEvidence;
};

export type GitlabPersonnelCandidate = {
  externalUsername: string;
  targetClass: GitlabTargetClass;
};

export type GitlabPersonnelEvidence = {
  reviewerField: "valid" | "missing" | "invalid" | "not_applicable";
  reviewerAdded: string[];
  assigneeAdded: string[];
  mentions: string[];
  anomalyCode: string | null;
};

export type AppliedGitlabPersonnel = {
  event: NormalizedScmEvent | null;
  candidates: GitlabPersonnelCandidate[];
  skippedBeforeIdentity: Array<
    GitlabPersonnelCandidate & { reason: "reviewer_mode_unconfirmed" | "review_target_schema_anomaly" }
  >;
  observeReviewers: boolean;
  schemaAnomalyCode: string | null;
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

function userUsername(value: unknown, label: string): string {
  const row = object(value, label);
  return normalizeGitlabUsername(requiredString(row.username, `${label}.username`, 255)).display;
}

function userArray(value: unknown, label: string, enforceTargetLimit = true): string[] {
  if (!Array.isArray(value)) throw new BadRequestError(`${label} must be an array`);
  if (enforceTargetLimit && value.length > MAX_GITLAB_PERSONNEL_TARGETS) {
    throw new GitlabPersonnelTargetLimitError();
  }
  return [...new Set(value.map((entry, index) => userUsername(entry, `${label}[${index}]`)))];
}

function optionalUserArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  return userArray(value, label);
}

function addedUsernames(current: string[], previous: string[]): string[] {
  const previousSet = new Set(previous.map((value) => value.toLocaleLowerCase("en-US")));
  return current.filter((value) => !previousSet.has(value.toLocaleLowerCase("en-US")));
}

function changedUserArray(changes: JsonObject | null, key: string): { present: boolean; added: string[] } {
  if (!changes || !(key in changes)) return { present: false, added: [] };
  const change = object(changes[key], `changes.${key}`);
  const previous = optionalUserArray(change.previous, `changes.${key}.previous`);
  const current = optionalUserArray(change.current, `changes.${key}.current`);
  return { present: true, added: addedUsernames(current, previous) };
}

function assigneeUsernames(payload: JsonObject, attrs: JsonObject, action: string | null): string[] {
  if (action !== "open" && action !== "update") return [];
  const current =
    "assignees" in payload
      ? optionalUserArray(payload.assignees, "assignees")
      : payload.assignee
        ? [userUsername(payload.assignee, "assignee")]
        : attrs.assignee
          ? [userUsername(attrs.assignee, "object_attributes.assignee")]
          : [];
  if (action === "open") return current;
  const changes = payload.changes ? object(payload.changes, "changes") : null;
  const multi = changedUserArray(changes, "assignees");
  if (multi.present) return multi.added;
  if (changes && "assignee" in changes) {
    const change = object(changes.assignee, "changes.assignee");
    const previous = change.previous ? [userUsername(change.previous, "changes.assignee.previous")] : [];
    const next = change.current ? [userUsername(change.current, "changes.assignee.current")] : [];
    return addedUsernames(next, previous);
  }
  // Older payloads may expose only assignee_id deltas. The current assignee
  // object remains the only username truth; a changed numeric id proves this
  // is a delta without being stored as identity.
  if (changes && "assignee_id" in changes) {
    const change = object(changes.assignee_id, "changes.assignee_id");
    if (change.previous !== change.current) return current;
  }
  return [];
}

function reviewerEvidence(
  payload: JsonObject,
  action: string | null,
): Pick<GitlabPersonnelEvidence, "reviewerField" | "reviewerAdded" | "anomalyCode"> {
  if (!("reviewers" in payload)) return { reviewerField: "missing", reviewerAdded: [], anomalyCode: null };
  if (!Array.isArray(payload.reviewers)) {
    return { reviewerField: "invalid", reviewerAdded: [], anomalyCode: "reviewers_wrong_type" };
  }
  let current: string[];
  try {
    current = userArray(payload.reviewers, "reviewers", action === "open" || action === "update");
  } catch (error) {
    if (error instanceof GitlabPersonnelTargetLimitError) throw error;
    return { reviewerField: "invalid", reviewerAdded: [], anomalyCode: "reviewers_invalid_entry" };
  }
  if (action === "open") return { reviewerField: "valid", reviewerAdded: current, anomalyCode: null };
  if (action !== "update") return { reviewerField: "valid", reviewerAdded: [], anomalyCode: null };
  let changes: JsonObject | null;
  try {
    changes = payload.changes ? object(payload.changes, "changes") : null;
    const delta = changedUserArray(changes, "reviewers");
    return delta.present
      ? { reviewerField: "valid", reviewerAdded: delta.added, anomalyCode: null }
      : { reviewerField: "valid", reviewerAdded: [], anomalyCode: "reviewers_delta_missing" };
  } catch (error) {
    if (error instanceof GitlabPersonnelTargetLimitError) throw error;
    return { reviewerField: "invalid", reviewerAdded: [], anomalyCode: "reviewers_changes_invalid" };
  }
}

function explicitMentions(body: string): string[] {
  const matches = body.matchAll(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]+)/g);
  const mentions = new Map<string, string>();
  for (const match of matches) {
    const username = normalizeGitlabUsername(match[2] ?? "");
    mentions.set(username.normalized, username.display);
    if (mentions.size > MAX_GITLAB_PERSONNEL_TARGETS) throw new GitlabPersonnelTargetLimitError();
  }
  return [...mentions.values()];
}

function assertPersonnelTargetLimit(personnel: GitlabPersonnelEvidence): void {
  const usernames = new Set(
    [...personnel.reviewerAdded, ...personnel.assigneeAdded, ...personnel.mentions].map(
      (username) => normalizeGitlabUsername(username).normalized,
    ),
  );
  if (usernames.size > MAX_GITLAB_PERSONNEL_TARGETS) throw new GitlabPersonnelTargetLimitError();
}

export function extractStableGitlabDeliveryId(headers: Record<string, unknown>, connectionId: string): string | null {
  const idempotencyKey = headers["idempotency-key"];
  const webhookId = headers["webhook-id"];
  if (idempotencyKey === undefined && webhookId === undefined) return null;
  for (const raw of [idempotencyKey, webhookId]) {
    if (raw === undefined) continue;
    if (typeof raw !== "string" || raw.length < 1 || raw.length > 256 || /[^\x21-\x7e]/.test(raw)) {
      throw new BadRequestError("GitLab stable delivery id header is invalid");
    }
  }
  if (idempotencyKey !== undefined && webhookId !== undefined && idempotencyKey !== webhookId) {
    throw new BadRequestError("GitLab stable delivery id headers must match");
  }
  const raw = webhookId ?? idempotencyKey;
  if (typeof raw !== "string") {
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
    return {
      ingress,
      event: null,
      entityIdentity: null,
      personnel: {
        reviewerField: "not_applicable",
        reviewerAdded: [],
        assigneeAdded: [],
        mentions: [],
        anomalyCode: null,
      },
    };
  }

  const project = object(payload.project, "project");
  const projectId = positiveInteger(project.id, "project.id");
  const projectPath = requiredString(project.path_with_namespace, "project.path_with_namespace", 1024);
  const projectUrl = gitlabUrl(project.web_url, input.instanceOrigin, "project.web_url");
  const user = object(payload.user, "user");
  const username = requiredString(user.username, "user.username", 255);
  let attrs: JsonObject;
  let entityType: "issue" | "pull_request";
  let eventType: string;
  let kind: NormalizedScmEvent["kind"];
  let personnel: GitlabPersonnelEvidence = {
    reviewerField: "not_applicable",
    reviewerAdded: [],
    assigneeAdded: [],
    mentions: [],
    anomalyCode: null,
  };
  let noteBody: string | undefined;

  if (expected === "merge_request") {
    attrs = object(payload.object_attributes, "object_attributes");
    entityType = "pull_request";
    eventType = "merge_request";
    const action = optionalString(attrs.action) ?? null;
    const reviewer = reviewerEvidence(payload, action);
    personnel = {
      ...reviewer,
      assigneeAdded: assigneeUsernames(payload, attrs, action),
      mentions: [],
    };
    kind = actionKind(action, "other");
  } else if (expected === "issue") {
    attrs = object(payload.object_attributes, "object_attributes");
    entityType = "issue";
    eventType = "issue";
    const action = optionalString(attrs.action) ?? null;
    personnel = {
      reviewerField: "not_applicable",
      reviewerAdded: [],
      assigneeAdded: assigneeUsernames(payload, attrs, action),
      mentions: [],
      anomalyCode: null,
    };
    kind = actionKind(action, "other");
  } else {
    attrs = object(payload.object_attributes, "object_attributes");
    const noteableType = requiredString(attrs.noteable_type, "object_attributes.noteable_type");
    if (noteableType !== "MergeRequest" && noteableType !== "Issue") {
      return {
        ingress,
        event: null,
        entityIdentity: null,
        personnel: {
          reviewerField: "not_applicable",
          reviewerAdded: [],
          assigneeAdded: [],
          mentions: [],
          anomalyCode: null,
        },
      };
    }
    const noteAttrs = attrs;
    noteBody = optionalString(noteAttrs.note) ?? "";
    const parent = object(noteableType === "MergeRequest" ? payload.merge_request : payload.issue, noteableType);
    attrs = { ...parent, url: parent.url ?? noteAttrs.url, action: noteAttrs.action };
    entityType = noteableType === "MergeRequest" ? "pull_request" : "issue";
    eventType = "note";
    kind = optionalString(attrs.action) === "update" ? "edited" : "commented";
    personnel = {
      reviewerField: "not_applicable",
      reviewerAdded: [],
      assigneeAdded: [],
      mentions: explicitMentions(noteBody),
      anomalyCode: null,
    };
  }

  assertPersonnelTargetLimit(personnel);

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
  return { ingress, event, entityIdentity, personnel };
}

export function applyGitlabPersonnelEvidence(
  normalized: NormalizedGitlabWebhook,
  reviewerMode: GitlabReviewerMode,
): AppliedGitlabPersonnel {
  if (!normalized.event) {
    return {
      event: null,
      candidates: [],
      skippedBeforeIdentity: [],
      observeReviewers: false,
      schemaAnomalyCode: null,
    };
  }
  const candidates: GitlabPersonnelCandidate[] = [];
  const skippedBeforeIdentity: AppliedGitlabPersonnel["skippedBeforeIdentity"] = [];
  const add = (externalUsername: string, targetClass: GitlabTargetClass): void => {
    const normalizedUsername = normalizeGitlabUsername(externalUsername).normalized;
    if (
      !candidates.some(
        (candidate) =>
          candidate.targetClass === targetClass &&
          normalizeGitlabUsername(candidate.externalUsername).normalized === normalizedUsername,
      )
    ) {
      candidates.push({ externalUsername, targetClass });
    }
  };

  if (normalized.event.eventType === "note") {
    for (const username of normalized.personnel.mentions) add(username, "mention");
  } else if (normalized.event.eventType === "issue") {
    for (const username of normalized.personnel.assigneeAdded) add(username, "assignee");
  } else if (normalized.event.eventType === "merge_request") {
    const reviewerEvidenceIsUsable =
      normalized.personnel.reviewerField === "valid" && !normalized.personnel.anomalyCode;
    const legacyAssigneeIsReviewer = normalized.personnel.reviewerField === "missing" && reviewerMode === "assignee";
    if (reviewerEvidenceIsUsable) {
      for (const username of normalized.personnel.reviewerAdded) add(username, "reviewer");
      for (const username of normalized.personnel.assigneeAdded) add(username, "assignee");
    } else if (legacyAssigneeIsReviewer) {
      for (const username of normalized.personnel.assigneeAdded) add(username, "reviewer");
    } else {
      for (const username of normalized.personnel.assigneeAdded) add(username, "assignee");
      if (normalized.personnel.reviewerField === "missing" && reviewerMode === "unknown") {
        for (const username of normalized.personnel.assigneeAdded) {
          skippedBeforeIdentity.push({
            externalUsername: username,
            targetClass: "reviewer",
            reason: "reviewer_mode_unconfirmed",
          });
        }
      }
    }
  }

  const targets = candidates.map((candidate) => ({
    externalUsername: candidate.externalUsername,
    reason: targetClassToReason(candidate.targetClass),
  }));
  return {
    event: { ...normalized.event, targets },
    candidates,
    skippedBeforeIdentity,
    observeReviewers: normalized.personnel.reviewerField === "valid",
    schemaAnomalyCode: normalized.personnel.anomalyCode
      ? normalized.personnel.anomalyCode
      : normalized.personnel.reviewerField === "invalid"
        ? (normalized.personnel.anomalyCode ?? "reviewers_invalid")
        : normalized.event.eventType === "merge_request" &&
            normalized.personnel.reviewerField === "missing" &&
            reviewerMode === "reviewers"
          ? "reviewers_missing_after_capability"
          : null,
  };
}

function targetClassToReason(targetClass: GitlabTargetClass): InvolveReason {
  switch (targetClass) {
    case "reviewer":
      return "review_requested";
    case "assignee":
      return "assigned";
    case "mention":
      return "mentioned";
  }
}

function reasonToTargetClass(reason: InvolveReason): GitlabTargetClass {
  switch (reason) {
    case "review_requested":
      return "reviewer";
    case "assigned":
      return "assignee";
    case "mentioned":
      return "mention";
  }
}

export async function resolveGitlabBasicAudience(db: Database, connectionId: string, identity: GitlabEntityIdentity) {
  const rows = await observeGitlabEntityAndResolveFollowers(db, connectionId, identity);
  const byChat = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!byChat.has(row.chatId)) byChat.set(row.chatId, row);
  return { targets: [...byChat.values()], actorHumanId: null };
}

export type GitlabAudienceResolution = {
  targets: ScmAudienceTarget[];
  actorHumanId: string | null;
};

export async function resolveGitlabAudience(
  db: Database,
  input: {
    organizationId: string;
    connectionId: string;
    automaticActionsEnabled: boolean;
    event: NormalizedScmEvent;
    entityIdentity: GitlabEntityIdentity;
    skippedBeforeIdentity: AppliedGitlabPersonnel["skippedBeforeIdentity"];
  },
): Promise<GitlabAudienceResolution> {
  const actorNormalizedUsername = normalizeGitlabUsername(input.event.actor.externalUsername).normalized;
  let actorHumanId: string | null = null;
  if (input.automaticActionsEnabled) {
    const identityRows = await db
      .select({ identityLinkId: gitlabEntityChatMappings.identityLinkId })
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, input.connectionId),
          eq(gitlabEntityChatMappings.projectId, input.entityIdentity.projectId),
          eq(gitlabEntityChatMappings.entityType, input.entityIdentity.entityType),
          eq(gitlabEntityChatMappings.entityIid, input.entityIdentity.entityIid),
          eq(gitlabEntityChatMappings.boundVia, "identity_target"),
          eq(gitlabEntityChatMappings.active, true),
        ),
      );
    await lockGitlabIdentityAuthoritySet(db, {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      normalizedUsernames: input.event.targets
        .map((target) => normalizeGitlabUsername(target.externalUsername).normalized)
        .concat(actorNormalizedUsername),
      identityLinkIds: identityRows.flatMap((row) => (row.identityLinkId ? [row.identityLinkId] : [])),
    });
    const actor = await resolveActiveGitlabIdentity(db, {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      normalizedUsername: actorNormalizedUsername,
      lockForUpdate: true,
    });
    actorHumanId = actor.outcome === "ok" ? actor.identity.humanAgentId : null;
  }
  const rows = await observeGitlabEntityAndResolveFollowers(db, input.connectionId, input.entityIdentity);
  const explicitDeclaredByIds = [
    ...new Set(rows.filter((row) => row.boundVia !== "identity_target").map((row) => row.declaredByAgentId)),
  ];
  const explicitOwnerRows =
    explicitDeclaredByIds.length === 0
      ? []
      : await db
          .select({ declaredByAgentId: agents.uuid, humanAgentId: members.agentId })
          .from(agents)
          .innerJoin(
            members,
            and(
              eq(agents.managerId, members.id),
              eq(members.organizationId, input.organizationId),
              eq(members.status, "active"),
            ),
          )
          .where(and(eq(agents.organizationId, input.organizationId), inArray(agents.uuid, explicitDeclaredByIds)));
  const explicitOwnerHumanByAgent = new Map(explicitOwnerRows.map((row) => [row.declaredByAgentId, row.humanAgentId]));
  const targets: ScmAudienceTarget[] = [];
  for (const row of rows) {
    if (row.boundVia === "identity_target") {
      if (!input.automaticActionsEnabled || !row.identityLinkId || !row.humanAgentId || !row.delegateAgentId) continue;
      const [link] = await db
        .select({ normalizedUsername: gitlabIdentityLinks.normalizedUsername })
        .from(gitlabIdentityLinks)
        .where(
          and(
            eq(gitlabIdentityLinks.id, row.identityLinkId),
            eq(gitlabIdentityLinks.connectionId, input.connectionId),
            eq(gitlabIdentityLinks.state, "active"),
          ),
        )
        .limit(1);
      if (!link) continue;
      const resolved = await resolveActiveGitlabIdentity(db, {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        normalizedUsername: link.normalizedUsername,
        lockForUpdate: true,
      });
      if (
        resolved.outcome !== "ok" ||
        resolved.identity.linkId !== row.identityLinkId ||
        resolved.identity.humanAgentId !== row.humanAgentId ||
        resolved.identity.delegateAgentId !== row.delegateAgentId
      ) {
        continue;
      }
      targets.push({
        senderAgentId: row.humanAgentId,
        humanAgentId: row.humanAgentId,
        wakeAgentId: row.delegateAgentId,
        authorityKey: row.identityLinkId,
        kind: "existing",
        chatId: row.chatId,
        involveReason: null,
        involveLogin: null,
      });
    } else {
      targets.push({
        senderAgentId: row.declaredByAgentId,
        humanAgentId: explicitOwnerHumanByAgent.get(row.declaredByAgentId) ?? null,
        wakeAgentId: null,
        kind: "existing",
        chatId: row.chatId,
        involveReason: null,
        involveLogin: null,
      });
    }
  }

  const allPersonnel = [
    ...input.event.targets.map((target) => ({
      externalUsername: target.externalUsername,
      targetClass: reasonToTargetClass(target.reason),
      reason: null,
    })),
    ...input.skippedBeforeIdentity,
  ];
  if (!input.automaticActionsEnabled) {
    for (const target of allPersonnel) {
      await recordGitlabSkippedTarget(db, {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        entityKey: input.event.entity.key,
        targetClass: target.targetClass,
        externalUsername: target.externalUsername,
        reason: "automatic_actions_disabled",
      });
    }
    return { targets, actorHumanId: null };
  }

  for (const skipped of input.skippedBeforeIdentity) {
    await recordGitlabSkippedTarget(db, {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      entityKey: input.event.entity.key,
      targetClass: skipped.targetClass,
      externalUsername: skipped.externalUsername,
      reason: skipped.reason,
    });
  }

  for (const target of input.event.targets) {
    const normalizedUsername = normalizeGitlabUsername(target.externalUsername).normalized;
    const resolved = await resolveActiveGitlabIdentity(db, {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      normalizedUsername,
      lockForUpdate: true,
    });
    if (resolved.outcome !== "ok") {
      await recordGitlabSkippedTarget(db, {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        entityKey: input.event.entity.key,
        targetClass: reasonToTargetClass(target.reason),
        externalUsername: target.externalUsername,
        reason: resolved.outcome,
      });
      continue;
    }
    const existingIndex = targets.findIndex(
      (candidate) =>
        candidate.humanAgentId === resolved.identity.humanAgentId &&
        candidate.wakeAgentId === resolved.identity.delegateAgentId &&
        candidate.kind === "existing",
    );
    if (existingIndex >= 0) {
      const existing = targets[existingIndex];
      if (existing) {
        targets.push({
          ...existing,
          involveReason: target.reason,
          involveLogin: normalizedUsername,
        });
      }
      continue;
    }
    targets.push({
      senderAgentId: resolved.identity.humanAgentId,
      humanAgentId: resolved.identity.humanAgentId,
      wakeAgentId: resolved.identity.delegateAgentId,
      authorityKey: resolved.identity.linkId,
      kind: "new",
      chatId: null,
      involveReason: target.reason,
      involveLogin: normalizedUsername,
    });
  }

  return { targets, actorHumanId };
}

async function resolveGitlabTargetChat(
  db: Database,
  input: {
    organizationId: string;
    connectionId: string;
    event: NormalizedScmEvent;
    entity: GitlabEntityIdentity;
    target: ScmAudienceTarget;
  },
): Promise<{ chatId: string; created: boolean } | null> {
  if (input.target.kind === "existing") {
    if (!input.target.chatId) throw new Error("existing GitLab audience target must carry chatId");
    return { chatId: input.target.chatId, created: false };
  }
  if (!input.target.humanAgentId || !input.target.wakeAgentId || !input.target.involveLogin) {
    throw new Error("new GitLab audience target requires human, delegate, and identity username");
  }
  const resolvedIdentity = await resolveActiveGitlabIdentity(db, {
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    normalizedUsername: input.target.involveLogin,
    lockForUpdate: true,
  });
  if (resolvedIdentity.outcome !== "ok") return null;

  const existingRows = await db
    .select()
    .from(gitlabEntityChatMappings)
    .where(
      and(
        eq(gitlabEntityChatMappings.connectionId, input.connectionId),
        eq(gitlabEntityChatMappings.projectId, input.entity.projectId),
        eq(gitlabEntityChatMappings.entityType, input.entity.entityType),
        eq(gitlabEntityChatMappings.entityIid, input.entity.entityIid),
      ),
    );
  const activeOwn = existingRows.find(
    (row) =>
      row.active &&
      row.identityLinkId === resolvedIdentity.identity.linkId &&
      row.humanAgentId === input.target.humanAgentId &&
      row.delegateAgentId === input.target.wakeAgentId,
  );
  if (activeOwn) return { chatId: activeOwn.chatId, created: false };

  const staleActiveOwnIds = existingRows
    .filter((row) => row.active && row.identityLinkId === resolvedIdentity.identity.linkId)
    .map((row) => row.id);
  if (staleActiveOwnIds.length > 0) {
    await db
      .update(gitlabEntityChatMappings)
      .set({ active: false, updatedAt: new Date() })
      .where(inArray(gitlabEntityChatMappings.id, staleActiveOwnIds));
  }
  const inactiveOwn = existingRows.find(
    (row) =>
      !row.active &&
      row.identityLinkId === resolvedIdentity.identity.linkId &&
      row.humanAgentId === input.target.humanAgentId &&
      row.delegateAgentId === input.target.wakeAgentId,
  );
  if (inactiveOwn) {
    const [reactivated] = await db
      .update(gitlabEntityChatMappings)
      .set({ active: true, updatedAt: new Date() })
      .where(eq(gitlabEntityChatMappings.id, inactiveOwn.id))
      .returning({ chatId: gitlabEntityChatMappings.chatId });
    if (reactivated) return { chatId: reactivated.chatId, created: false };
  }

  const activeChatIds = [...new Set(existingRows.filter((row) => row.active).map((row) => row.chatId))];
  const reusable: string[] = [];
  for (const chatId of activeChatIds) {
    const participantRows = await db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, chatId),
          eq(chatMembership.accessMode, "speaker"),
          inArray(chatMembership.agentId, [input.target.humanAgentId, input.target.wakeAgentId]),
        ),
      );
    const participantIds = new Set(participantRows.map((row) => row.agentId));
    if (participantIds.has(input.target.humanAgentId) && participantIds.has(input.target.wakeAgentId)) {
      reusable.push(chatId);
    }
  }

  let chatId: string;
  let created = false;
  if (reusable.length === 1) {
    chatId = reusable[0] ?? "";
  } else {
    const metadata = chatMetadataSchema.parse({
      source: "gitlab",
      entityType: input.entity.entityType,
      entityKey: input.event.entity.key,
      entityUrl: input.entity.entityUrl,
      ...(input.target.involveReason === "review_requested" ? { reviewRequestRouted: true } : {}),
    });
    const prefix = input.entity.entityType === "pull_request" ? "MR" : "Issue";
    const sigil = input.entity.entityType === "pull_request" ? "!" : "#";
    const createdChat = await createChat(db, input.target.humanAgentId, {
      type: "group",
      participantIds: [input.target.wakeAgentId],
      topic: `${prefix} ${sigil}${input.entity.entityIid}: ${input.entity.title ?? input.event.surface.title}`,
      metadata,
    });
    chatId = createdChat.id;
    created = true;
  }

  await db.insert(gitlabEntityChatMappings).values({
    id: uuidv7(),
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    chatId,
    declaredByAgentId: input.target.humanAgentId,
    boundVia: "identity_target",
    identityLinkId: resolvedIdentity.identity.linkId,
    humanAgentId: input.target.humanAgentId,
    delegateAgentId: input.target.wakeAgentId,
    active: true,
    entityType: input.entity.entityType,
    entityIid: input.entity.entityIid,
    projectId: input.entity.projectId,
    projectPath: input.entity.projectPath,
    projectPathNormalized: normalizeGitlabProjectPath(input.entity.projectPath),
    entityUrl: input.entity.entityUrl,
    title: input.entity.title,
    entityState: input.entity.entityState,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { chatId, created };
}

export async function deliverGitlabCards(
  app: FastifyInstance,
  input: {
    event: NormalizedScmEvent;
    identity: GitlabEntityIdentity;
    audience: GitlabAudienceResolution;
    organizationId: string;
    connectionId: string;
    expectedTokenHash: string;
    database: Database;
  },
) {
  const stats: {
    delivered: number;
    newChats: number;
    failed: number;
    postCommitEffects: DeferredGitlabCardPostCommitEffects[];
  } = { delivered: 0, newChats: 0, failed: 0, postCommitEffects: [] };
  const planned = await planScmChatDeliveries({
    targets: input.audience.targets,
    actorHumanId: input.audience.actorHumanId,
    resolveChat: (target) =>
      resolveGitlabTargetChat(input.database, {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        event: input.event,
        entity: input.identity,
        target,
      }),
    onTargetError: (target, err) => {
      log.error(
        {
          err,
          metric: "gitlab_delivery_failed_total",
          humanAgentId: target.humanAgentId,
          delegateAgentId: target.wakeAgentId,
          entityKey: input.event.entity.key,
        },
        "failed to resolve chat for normalized GitLab target",
      );
    },
  });
  stats.failed += planned.failed;

  for (const delivery of planned.deliveries.values()) {
    try {
      const entries = [...delivery.entries.values()].sort(compareScmDeliveryEntries);
      const senderId = selectScmSenderId(entries);
      const context = selectScmCardContext(entries);
      const reason = context.involveReason ?? "subscribed";
      if (input.event.entity.type !== "issue" && input.event.entity.type !== "pull_request") {
        throw new Error(`Unsupported GitLab card entity type: ${input.event.entity.type}`);
      }
      const card: GitlabEventCard = {
        type: "gitlab_event",
        event: input.event.eventType,
        action: input.event.action,
        kind: input.event.kind,
        project: input.identity.projectPath,
        sender: input.event.actor.externalUsername,
        title: input.event.surface.title,
        body: input.event.surface.body,
        url: input.event.surface.url,
        entity: {
          type: input.event.entity.type,
          key: input.event.entity.key,
          url: input.event.entity.url ?? null,
        },
        reason,
        ...(context.involveLogin ? { mentionedUser: context.involveLogin } : {}),
        ...(reason === "review_requested" ? { reviewRoutingStatus: "routed_source_not_ready" as const } : {}),
      };
      const mentions = scmWakeAgentIds(entries);
      const identityAuthorities = new Map<string, GitlabIdentityAuthorityProof>();
      for (const entry of entries) {
        for (const identityLinkId of entry.authorityKeys) {
          if (!entry.humanAgentId || !entry.wakeAgentId) {
            throw new Error("GitLab identity authority requires a human and delegate agent");
          }
          const proof = {
            identityLinkId,
            humanAgentId: entry.humanAgentId,
            delegateAgentId: entry.wakeAgentId,
          };
          const existing = identityAuthorities.get(identityLinkId);
          if (
            existing &&
            (existing.humanAgentId !== proof.humanAgentId || existing.delegateAgentId !== proof.delegateAgentId)
          ) {
            throw new Error("GitLab identity authority changed within one delivery plan");
          }
          identityAuthorities.set(identityLinkId, proof);
        }
      }
      const sent = await sendScmSystemCard(app, {
        chatId: delivery.chatId,
        senderId,
        provider: "gitlab",
        content: card,
        metadata: {
          event: input.event.eventType,
          action: input.event.action,
          entityType: input.event.entity.type,
          entityKey: input.event.entity.key,
          reason,
          ...(mentions.length > 0 ? { mentions } : {}),
          ...(context.involveLogin ? { mentionedUser: context.involveLogin } : {}),
        },
        database: input.database,
        deferPostCommitEffects: true,
      });
      if (!sent.deferredPostCommitEffects) throw new Error("GitLab card delivery did not defer post-commit effects");
      stats.postCommitEffects.push({
        effects: sent.deferredPostCommitEffects,
        authority: {
          organizationId: input.organizationId,
          connectionId: input.connectionId,
          tokenHash: input.expectedTokenHash,
          identities: [...identityAuthorities.values()],
        },
      });
      stats.delivered += 1;
      if (delivery.created) stats.newChats += 1;
    } catch (err) {
      stats.failed += 1;
      log.error(
        { err, metric: "gitlab_delivery_failed_total", chatId: delivery.chatId, entityKey: input.event.entity.key },
        "failed to deliver normalized GitLab event to chat",
      );
    }
  }
  return stats;
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
