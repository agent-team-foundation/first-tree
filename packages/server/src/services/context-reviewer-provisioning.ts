import { AGENT_TYPES, AGENT_VISIBILITY, ORG_SETTINGS_NAMESPACES } from "@first-tree/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { ConflictError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { createAgent } from "./agent.js";

export const INITIAL_CONTEXT_REVIEWER_PROMPT =
  "Use $context-tree-review for Context Tree pull request and merge request review work.";

const CONTEXT_REVIEWER_AGENT_NAME = "context-reviewer";
const CONTEXT_REVIEWER_DISPLAY_NAME = "Context Reviewer";

class InvalidContextReviewerAssignmentError extends Error {}

type EnsureInitializedContextReviewerInput = {
  organizationId: string;
  managerId: string;
  updatedBy: string;
};

/**
 * Complete Context Tree initialization with a dedicated Reviewer Agent.
 *
 * The caller holds the organization settings mutation lock and runs this
 * helper in the same transaction as the new Context Tree binding. The feature
 * assignment is the idempotency key: an existing assignment is preserved, so
 * retries never create another Reviewer Agent.
 */
export async function ensureInitializedContextReviewer(
  db: Database,
  input: EnsureInitializedContextReviewerInput,
): Promise<{ agentUuid: string; created: boolean }> {
  const [featuresRow] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(
      and(
        eq(organizationSettings.organizationId, input.organizationId),
        eq(organizationSettings.namespace, "context_tree_features"),
      ),
    )
    .limit(1);
  const features = ORG_SETTINGS_NAMESPACES.context_tree_features.storage.parse(featuresRow?.value ?? {});
  const configuredAgentUuid = features.contextReviewer.agentUuid;

  if (
    configuredAgentUuid &&
    (await preserveValidContextReviewerAssignment(db, input.organizationId, configuredAgentUuid))
  ) {
    if (!features.contextReviewer.enabled) {
      await saveContextReviewerAssignment(db, input, configuredAgentUuid);
    }
    return { agentUuid: configuredAgentUuid, created: false };
  }

  const reviewer = await createContextReviewerAgent(db, input);
  await db.insert(agentResourceBindings).values({
    id: uuidv7(),
    organizationId: input.organizationId,
    agentId: reviewer.uuid,
    type: "prompt",
    mode: "include",
    resourceId: null,
    replacesResourceId: null,
    inlinePromptBody: INITIAL_CONTEXT_REVIEWER_PROMPT,
    repoRef: null,
    repoLocalPath: null,
    order: 0,
    createdBy: input.managerId,
    updatedBy: input.managerId,
  });
  await saveContextReviewerAssignment(db, input, reviewer.uuid);
  return { agentUuid: reviewer.uuid, created: true };
}

/**
 * Validate inside a savepoint so an invalid assignment releases its Agent row
 * lock before replacement creation takes the new manager's member lock. A
 * successful savepoint keeps its row lock until the caller's outer transaction
 * commits, preserving idempotency against concurrent lifecycle writes.
 */
async function preserveValidContextReviewerAssignment(
  db: Database,
  organizationId: string,
  agentUuid: string,
): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      if (!(await lockValidContextReviewerAgent(txDb, organizationId, agentUuid))) {
        throw new InvalidContextReviewerAssignmentError();
      }
    });
    return true;
  } catch (error) {
    if (error instanceof InvalidContextReviewerAssignmentError) return false;
    throw error;
  }
}

/**
 * Lock the Agent before reading its current manager so reassignment, suspension,
 * and deletion serialize on one stable row. The manager read intentionally
 * remains non-locking: membership departure takes member → agent locks, so a
 * reverse lock here could deadlock. A concurrent departure that already owns
 * the member row is ordered after this transaction when it reaches the locked
 * Agent; one that commits first is visible through the Agent's current manager.
 */
async function lockValidContextReviewerAgent(
  db: Database,
  organizationId: string,
  agentUuid: string,
): Promise<boolean> {
  const [agent] = await db
    .select({
      managerId: agents.managerId,
      organizationId: agents.organizationId,
      status: agents.status,
      type: agents.type,
    })
    .from(agents)
    .where(eq(agents.uuid, agentUuid))
    .for("update")
    .limit(1);
  if (
    !agent ||
    agent.organizationId !== organizationId ||
    agent.type !== AGENT_TYPES.AGENT ||
    agent.status !== "active"
  ) {
    return false;
  }

  const [manager] = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(eq(members.id, agent.managerId), eq(members.organizationId, organizationId), eq(members.status, "active")),
    )
    .limit(1);
  return Boolean(manager);
}

async function createContextReviewerAgent(
  db: Database,
  input: EnsureInitializedContextReviewerInput,
): ReturnType<typeof createAgent> {
  const [existingName] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, input.organizationId),
        eq(agents.name, CONTEXT_REVIEWER_AGENT_NAME),
        ne(agents.status, "deleted"),
      ),
    )
    .limit(1);
  const preferredName = existingName ? uniqueContextReviewerName() : CONTEXT_REVIEWER_AGENT_NAME;

  try {
    return await createAgent(db, {
      name: preferredName,
      type: AGENT_TYPES.AGENT,
      displayName: CONTEXT_REVIEWER_DISPLAY_NAME,
      organizationId: input.organizationId,
      managerId: input.managerId,
      source: "admin-api",
      visibility: AGENT_VISIBILITY.ORGANIZATION,
    });
  } catch (error) {
    // Agent creation is independent of the organization-settings lock. If a
    // concurrent user claims the clean slug after the read above, keep tree
    // initialization convergent with a collision-resistant dedicated slug.
    if (preferredName === CONTEXT_REVIEWER_AGENT_NAME && error instanceof ConflictError) {
      return createAgent(db, {
        name: uniqueContextReviewerName(),
        type: AGENT_TYPES.AGENT,
        displayName: CONTEXT_REVIEWER_DISPLAY_NAME,
        organizationId: input.organizationId,
        managerId: input.managerId,
        source: "admin-api",
        visibility: AGENT_VISIBILITY.ORGANIZATION,
      });
    }
    throw error;
  }
}

function uniqueContextReviewerName(): string {
  return `${CONTEXT_REVIEWER_AGENT_NAME}-${uuidv7().replaceAll("-", "").slice(-10)}`;
}

async function saveContextReviewerAssignment(
  db: Database,
  input: EnsureInitializedContextReviewerInput,
  agentUuid: string,
): Promise<void> {
  const value = ORG_SETTINGS_NAMESPACES.context_tree_features.storage.parse({
    contextReviewer: { enabled: true, agentUuid },
  });
  await db
    .insert(organizationSettings)
    .values({
      organizationId: input.organizationId,
      namespace: "context_tree_features",
      value,
      version: 1,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [organizationSettings.organizationId, organizationSettings.namespace],
      set: {
        value,
        version: sql`${organizationSettings.version} + 1`,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    });
}
