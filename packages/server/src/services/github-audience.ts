import {
  AGENT_STATUSES,
  AGENT_TYPES,
  type GithubAppInstallationPermissions,
  type GithubTaskReplyErrorCode,
  isDeclaredBoundVia,
  type NormalizedScmEvent,
  type ScmAudienceEntry,
} from "@first-tree/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { loadValidContextReviewerAgent } from "./context-reviewer-common.js";
import { normalizeGithubRepo } from "./context-reviewer-pr.js";
import { isGithubAppTargetLogin } from "./github-app-self-output.js";
import { githubEntityKeyCandidates } from "./github-entity-key.js";
import { getOrgContextReviewRuntime } from "./org-settings.js";
import {
  composeScmAudience,
  type ScmAudienceTarget,
  type ScmPersonnelTarget,
  type ScmProviderTaskTarget,
} from "./scm-audience-composition.js";
import { getTeamAgentUuid } from "./team-agent-settings.js";

/** Preserve the existing internal import surface while identity logic stays canonical. */
export { isGithubAppTargetLogin } from "./github-app-self-output.js";

/**
 * Why a delegate-target lookup did or didn't qualify. Hoisted to a discrete
 * union so the audience resolver and the operations log share one vocabulary
 * for the four outcomes — "ok" feeds the audience list, the other three
 * surface as structured warnings.
 */
export type DelegateTargetVerdict = "ok" | "not_found" | "cross_org" | "inactive";

export const DELEGATE_VERDICT_MESSAGES: Record<DelegateTargetVerdict, string> = {
  ok: "delegate_mention target eligible",
  not_found: "delegate_mention target not found, skipping",
  cross_org: "delegate_mention target belongs to another org, skipping",
  inactive: "delegate_mention target not active, skipping",
};

export function evaluateDelegateTarget(
  target: { organizationId: string; status: string } | undefined,
  sourceOrgId: string,
): DelegateTargetVerdict {
  if (!target) return "not_found";
  if (target.organizationId !== sourceOrgId) return "cross_org";
  if (target.status !== "active") return "inactive";
  return "ok";
}

/**
 * Resolve the GitHub actor to the represented First Tree human when possible.
 *
 * GitHub tells us which login triggered the event; it does not tell us which
 * local agent, if any, performed the action. Echo wake suppression is therefore
 * human-scoped: if the actor login maps to an org-local human agent, delivery
 * can silence matching existing lines while retaining their card routes.
 * Unknown humans, external users, and bot/app senders return null and are
 * delivered without guessed suppression.
 */
export async function resolveGithubActorHumanId(
  db: Database,
  organizationId: string,
  actor: { externalUsername: string },
): Promise<string | null> {
  const [agentRow] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.type, AGENT_TYPES.HUMAN),
        eq(sql`lower(${agents.name})`, actor.externalUsername.toLowerCase()),
      ),
    )
    .limit(1);
  return agentRow?.uuid ?? null;
}

export type GithubProviderTaskContext = {
  kind: "github_app_task";
  agentUuid: string;
};

export type AudienceResolution = {
  targets: ScmAudienceTarget<GithubProviderTaskContext>[];
  actorHumanId: string | null;
  appTaskBlocker: GithubTaskReplyErrorCode | null;
};

export type GithubAudienceOptions = {
  appSlug?: string | null;
  appPermissions?: GithubAppInstallationPermissions;
  /**
   * Canonical `isGithubAppSelfOutput` verdict for this webhook. When set, the
   * event only reports First Tree's own App output, so it keeps its ordinary
   * subscription routes but must not mint another provider task.
   */
  appSelfOutput?: boolean;
};

export function isGithubTaskReplySupported(
  entityType: NormalizedScmEvent["entity"]["type"],
  permissions: GithubAppInstallationPermissions | undefined,
): boolean {
  if (entityType === "issue") return permissions?.issues === "write";
  if (entityType === "pull_request") return permissions?.pull_requests === "write";
  return false;
}

/**
 * Entity types an automatic provider task may cover. Discussion and commit
 * events are out of scope: the App has no safe terminal comment publisher for
 * them, so routing one would create work an Agent cannot finish.
 */
function isGithubTaskEntityType(event: NormalizedScmEvent): boolean {
  return event.entity.type === "issue" || event.entity.type === "pull_request";
}

/** The immutable Issue / PR identity the App reply publisher is bound to. */
function hasGithubTaskEntityIdentity(event: NormalizedScmEvent): boolean {
  const match = /#([1-9]\d*)$/u.exec(event.entity.key);
  if (!match?.[1] || !Number.isSafeInteger(Number(match[1]))) return false;
  try {
    return new URL(event.entity.url ?? event.surface.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Pick the repository's task role. The bound GitHub Context Tree repository
 * keeps its dedicated Context Reviewer; every other connected repository goes
 * to the team's GitHub Task Agent.
 */
async function resolveGithubAppTaskAgent(
  db: Database,
  event: NormalizedScmEvent,
): Promise<Awaited<ReturnType<typeof loadValidContextReviewerAgent>>> {
  const runtime = await getOrgContextReviewRuntime(db, event.source.organizationId);
  const contextRepo =
    runtime.bindingState === "bound" &&
    runtime.provider === "github" &&
    runtime.providerMatchesRepository &&
    normalizeGithubRepo(runtime.repo) === normalizeGithubRepo(event.entity.projectKey);
  const agentUuid = contextRepo
    ? runtime.contextReviewer.agentUuid
    : await getTeamAgentUuid(db, event.source.organizationId);
  if (!agentUuid) return null;
  return loadValidContextReviewerAgent(db, {
    organizationId: event.source.organizationId,
    reviewerAgentUuid: agentUuid,
  });
}

/**
 * Compute the Stage 2 audience for a normalized event.
 *
 *   audience = follow mappings ∪ personnel deliveries ∪ automatic provider task
 *
 * Provider code resolves rows and external identities; shared SCM composition
 * owns exact-pair target matching and preserves every distinct route. The
 * automatic provider task is a repository-scoped capability, not a personnel
 * route: it carries no involve reason and no external login, so a chat reached
 * only by it renders as `subscribed` with the event's real kind.
 */
export async function resolveGithubAudience(
  db: Database,
  event: NormalizedScmEvent,
  options: GithubAudienceOptions = {},
): Promise<AudienceResolution> {
  const organizationId = event.source.organizationId;
  const entityKeys = githubEntityKeyCandidates(event.entity.type, event.entity.key);
  const actorHumanId = await resolveGithubActorHumanId(db, organizationId, event.actor);
  // The App login can still appear as a payload mention or assignee. It is
  // never a personnel target: no First Tree human carries it, and provider-task
  // routing no longer reads it.
  const humanTargets = event.targets.filter(
    (target) => !isGithubAppTargetLogin(target.externalUsername, options.appSlug),
  );
  let appTaskBlocker: GithubTaskReplyErrorCode | null = null;

  const subscribedRows = await db
    .select({
      humanAgentId: githubEntityChatMappings.humanAgentId,
      humanAgentName: agents.name,
      delegateAgentId: githubEntityChatMappings.delegateAgentId,
      chatId: githubEntityChatMappings.chatId,
      boundAt: githubEntityChatMappings.boundAt,
      boundVia: githubEntityChatMappings.boundVia,
    })
    .from(githubEntityChatMappings)
    .innerJoin(agents, eq(agents.uuid, githubEntityChatMappings.humanAgentId))
    .where(
      and(
        eq(githubEntityChatMappings.organizationId, organizationId),
        eq(githubEntityChatMappings.entityType, event.entity.type),
        inArray(githubEntityChatMappings.entityKey, entityKeys),
      ),
    );

  // Dedup subscribed rows by `(humanAgentId, delegateAgentId, chatId)` (keep
  // earliest `bound_at`). Alias entity keys can leave duplicate rows for the
  // same logical attention line, but distinct delegates are distinct wake
  // lines even when they share one human carrier and chat. The per-chat
  // delivery planner collapses those lines into one card and unions every
  // wake agent.
  //
  // The key MUST include `chatId`. Deduping by `humanAgentId` alone assumed
  // every row for a human shared one chat — false once the same human is
  // bound to the entity from more than one chat (e.g. a webhook
  // `human_fallback` row in one chat plus an explicit `follow` row in
  // another, each under a different delegate). Collapsing across chats kept
  // only the earliest chat's row and silently dropped every *other* followed
  // chat from the audience — that chat never received the entity's events at
  // all. The key also includes `delegateAgentId`: two agent-issued follows can
  // share the same fallback human and chat while carrying distinct wake
  // agents. "The chat follows, not the person", so the surviving unit is one
  // row per (human, delegate, chat).
  const earliestByAttentionLine = new Map<string, (typeof subscribedRows)[number]>();
  for (const row of subscribedRows) {
    const key = `${row.humanAgentId}:${row.delegateAgentId}:${row.chatId}`;
    const current = earliestByAttentionLine.get(key);
    if (!current || row.boundAt < current.boundAt) {
      earliestByAttentionLine.set(key, row);
    }
  }
  // #766: A `pull_request.opened` delivery reaching a reviewer purely through
  // the subscribed path renders a redundant "opened this" card right next to
  // the actionable "requested your review" one. This happens during PR
  // creation: GitHub fires `opened` and `review_requested` near-simultaneously,
  // and when `review_requested` is processed first it mints the mapping, so the
  // racing `opened` then sees that mapping and fans out as a subscribed card.
  // Drop those subscribed `opened` targets. Two carve-outs preserve genuinely
  // useful `opened` delivery:
  //   - declared bindings (`agent_declared` / `human_declared`): the mapping
  //     was explicitly followed BEFORE the `opened` webhook arrived — the
  //     canonical case is an agent that just created the PR and followed it
  //     in the same breath (see `services/github-entity-follow.ts`). The
  //     "opened this" card is the deliberate creation confirmation / first
  //     signal of the declared watch, not a review-routing echo.
  //   - the target is explicitly named (mention / assignee) in the `opened`
  //     payload: an intentional, directed signal worth keeping.
  // Scope is intentionally narrow: `pull_request` + `opened` only. `issues`
  // has no `review_requested`, and every other event (synchronize, review,
  // comment, …) is a legitimately distinct subscribed signal.
  const isPullRequestOpened = event.eventType === "pull_request" && event.action === "opened";
  const involvedLogins = new Set(event.targets.map((target) => target.externalUsername.toLowerCase()));
  const keepSubscribedOpened = (row: (typeof subscribedRows)[number]): boolean => {
    if (!isPullRequestOpened) return true;
    if (isDeclaredBoundVia(row.boundVia)) return true;
    return row.humanAgentName !== null && involvedLogins.has(row.humanAgentName.toLowerCase());
  };

  const existingEntries: Array<Extract<ScmAudienceEntry, { kind: "existing_line" }>> = [
    ...earliestByAttentionLine.values(),
  ]
    .filter(keepSubscribedOpened)
    .map((row) => ({
      kind: "existing_line",
      line: {
        kind: "attention_line",
        humanAgentId: row.humanAgentId,
        wakeAgentId: row.delegateAgentId,
        chatId: row.chatId,
        provenance: isDeclaredBoundVia(row.boundVia)
          ? "explicit"
          : row.boundVia === "fixes_link"
            ? "related_entity"
            : "identity_target",
      },
    }));

  const personnelTargets: ScmPersonnelTarget[] = [];
  if (humanTargets.length > 0) {
    const candidateLogins = humanTargets.map((target) => target.externalUsername.toLowerCase());
    const targetsByLogin = new Map<string, typeof humanTargets>();
    for (const target of humanTargets) {
      const login = target.externalUsername.toLowerCase();
      const targets = targetsByLogin.get(login);
      if (targets) targets.push(target);
      else targetsByLogin.set(login, [target]);
    }

    const candidates = await db
      .select({
        id: agents.uuid,
        name: agents.name,
        delegateMention: agents.delegateMention,
        status: agents.status,
      })
      .from(agents)
      .where(
        and(
          eq(agents.organizationId, organizationId),
          eq(agents.type, AGENT_TYPES.HUMAN),
          inArray(sql`lower(${agents.name})`, candidateLogins),
        ),
      );

    const delegateIds = new Set<string>();
    for (const c of candidates) {
      if (c.delegateMention) delegateIds.add(c.delegateMention);
    }
    const delegateRows =
      delegateIds.size > 0
        ? await db
            .select({
              id: agents.uuid,
              organizationId: agents.organizationId,
              status: agents.status,
            })
            .from(agents)
            .where(inArray(agents.uuid, [...delegateIds]))
        : [];
    const delegateById = new Map<string, { organizationId: string; status: string }>();
    for (const row of delegateRows)
      delegateById.set(row.id, { organizationId: row.organizationId, status: row.status });

    for (const c of candidates) {
      if (c.status !== AGENT_STATUSES.ACTIVE || !c.name) continue;
      const candidateLogin = c.name.toLowerCase();
      const directedTargets = targetsByLogin.get(candidateLogin);
      if (!directedTargets) continue;

      if (!c.delegateMention) continue;
      const verdict = evaluateDelegateTarget(delegateById.get(c.delegateMention), organizationId);
      if (verdict !== "ok") continue;
      for (const target of directedTargets) {
        personnelTargets.push({
          kind: "personnel_target",
          reason: target.reason,
          requiresPersistentLine: target.reason === "assigned" || target.reason === "mentioned",
          humanAgentId: c.id,
          wakeAgentId: c.delegateMention,
          externalUsername: candidateLogin,
        });
      }
    }
  }

  // Automatic event routing. Every normalizer-accepted Issue / pull request
  // event is repository-scoped work for that repository's task role — no
  // `@app-slug` text, assignee, or `author_association` is consulted, because
  // an ordinary App bot isn't even selectable in GitHub's mention/assignee
  // pickers. The three skip conditions below drop only the automatic task and
  // never touch independent personnel targets or subscriptions.
  const providerTaskTargets: ScmProviderTaskTarget<GithubProviderTaskContext>[] = [];
  if (options.appSlug?.trim() && !options.appSelfOutput && isGithubTaskEntityType(event)) {
    const taskAgent = await resolveGithubAppTaskAgent(db, event);
    if (taskAgent) {
      if (!hasGithubTaskEntityIdentity(event)) {
        appTaskBlocker = "GITHUB_TASK_REPLY_ENTITY_UNSUPPORTED";
      } else if (!isGithubTaskReplySupported(event.entity.type, options.appPermissions)) {
        appTaskBlocker = "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED";
      } else {
        providerTaskTargets.push({
          kind: "provider_task_target",
          humanAgentId: taskAgent.managerHumanAgentId,
          wakeAgentId: taskAgent.uuid,
          providerContext: { kind: "github_app_task", agentUuid: taskAgent.uuid },
        });
      }
    }
  }

  const audience = composeScmAudience({ existingEntries, personnelTargets, providerTaskTargets });
  return { targets: audience, actorHumanId, appTaskBlocker };
}
