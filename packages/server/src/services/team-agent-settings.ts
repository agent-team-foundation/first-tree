import {
  ORG_SETTINGS_NAMESPACES,
  type OrgGithubFeaturesOutput,
  type OrgGithubFeaturesStorage,
  type SetupBlocker,
  type TeamAgentCandidatesOutput,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { loadValidContextReviewerAgent } from "./context-reviewer-common.js";
import { listContextReviewerCandidates } from "./context-reviewer-readiness.js";
import { findInstallationByOrg, type InstallationRow } from "./github-app-installations.js";
import { getOrgSetting } from "./org-settings.js";

export class TeamAgentSettingsError extends ConflictError {
  constructor(
    readonly blocker: SetupBlocker,
    message = "GitHub Task Agent is not ready",
  ) {
    super(message, { code: blocker.code });
    this.name = "TeamAgentSettingsError";
  }
}

function blocker(
  code: SetupBlocker["code"],
  actionKind: SetupBlocker["actionKind"],
  resolutionOwner: SetupBlocker["resolutionOwner"] = "admin",
): SetupBlocker {
  return { code, resolutionOwner, actionKind };
}

async function lockOrganization(db: Database, organizationId: string): Promise<void> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  if (!row) throw new NotFoundError(`Organization "${organizationId}" not found`);
}

async function readStorage(db: Database, organizationId: string): Promise<OrgGithubFeaturesStorage> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(
      and(
        eq(organizationSettings.organizationId, organizationId),
        eq(organizationSettings.namespace, "github_features"),
      ),
    )
    .limit(1);
  return ORG_SETTINGS_NAMESPACES.github_features.storage.parse(row?.value ?? {});
}

async function readContextReviewerAgentUuid(db: Database, organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(
      and(
        eq(organizationSettings.organizationId, organizationId),
        eq(organizationSettings.namespace, "context_tree_features"),
      ),
    )
    .limit(1);
  return ORG_SETTINGS_NAMESPACES.context_tree_features.storage.parse(row?.value ?? {}).contextReviewer.agentUuid;
}

function taskReplyInstallationBlocker(installation: InstallationRow | null): SetupBlocker | null {
  if (!installation) return null;
  if (installation.suspendedAt) return blocker("github_app_suspended", "manage_github_installation");
  if (installation.permissions.issues !== "write" || installation.permissions.pull_requests !== "write") {
    return blocker("github_app_task_reply_permission_required", "manage_github_installation");
  }
  return null;
}

async function writeStorage(
  db: Database,
  organizationId: string,
  storage: OrgGithubFeaturesStorage,
  updatedBy: string,
): Promise<void> {
  const validated = ORG_SETTINGS_NAMESPACES.github_features.storage.parse(storage);
  await db
    .insert(organizationSettings)
    .values({
      organizationId,
      namespace: "github_features",
      value: validated,
      version: 1,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [organizationSettings.organizationId, organizationSettings.namespace],
      set: {
        value: validated,
        version: sql`${organizationSettings.version} + 1`,
        updatedBy,
        updatedAt: new Date(),
      },
    });
}

export async function getTeamAgentUuid(db: Database, organizationId: string): Promise<string | null> {
  return (await readStorage(db, organizationId)).teamAgent.agentUuid;
}

export async function listTeamAgentCandidates(
  db: Database,
  input: {
    organizationId: string;
    appSlug: string | null | undefined;
    now: Date;
    staleSeconds: number;
  },
): Promise<TeamAgentCandidatesOutput> {
  if (!input.appSlug?.trim()) {
    return {
      items: [],
      blockers: [blocker("github_app_slug_missing", null, "operator")],
    };
  }
  const [candidates, reviewerAgentUuid, installation] = await Promise.all([
    listContextReviewerCandidates(db, input),
    readContextReviewerAgentUuid(db, input.organizationId),
    findInstallationByOrg(db, input.organizationId),
  ]);
  const installationBlocker = taskReplyInstallationBlocker(installation);
  if (installationBlocker) return { items: [], blockers: [installationBlocker] };
  return {
    items: candidates.items.filter((candidate) => candidate.uuid !== reviewerAgentUuid),
    blockers: candidates.items.some((candidate) => candidate.uuid !== reviewerAgentUuid)
      ? []
      : [blocker("context_review_no_eligible_agent", "open_agent_owner_flow")],
  };
}

export async function putTeamAgentAssignment(
  db: Database,
  organizationId: string,
  agentUuid: string | null,
  options: { updatedBy: string; appSlug: string | null | undefined },
): Promise<OrgGithubFeaturesOutput> {
  if (agentUuid !== null && !options.appSlug?.trim()) {
    throw new TeamAgentSettingsError(
      blocker("github_app_slug_missing", null, "operator"),
      "GitHub App login is required before selecting a GitHub Task Agent",
    );
  }

  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await lockOrganization(tx, organizationId);
    const current = await readStorage(tx, organizationId);

    if (agentUuid !== null) {
      const installationBlocker = taskReplyInstallationBlocker(await findInstallationByOrg(tx, organizationId));
      if (installationBlocker) {
        throw new TeamAgentSettingsError(
          installationBlocker,
          "The GitHub App installation is not ready to publish App-authored task replies",
        );
      }
      const reviewerAgentUuid = await readContextReviewerAgentUuid(tx, organizationId);
      if (reviewerAgentUuid === agentUuid) {
        throw new TeamAgentSettingsError(
          blocker("team_agent_conflicts_context_reviewer", "select_team_agent"),
          "Context Reviewer and GitHub Task Agent must be different Agents",
        );
      }
      const agent = await loadValidContextReviewerAgent(tx, {
        organizationId,
        reviewerAgentUuid: agentUuid,
      });
      if (!agent) {
        throw new TeamAgentSettingsError(
          blocker("context_review_agent_missing", "select_team_agent"),
          "GitHub Task Agent must be an active organization-visible non-human Agent with a managed runtime",
        );
      }
    }
    if (current.teamAgent.agentUuid === agentUuid) return;

    await writeStorage(tx, organizationId, { teamAgent: { agentUuid } }, options.updatedBy);
  });

  return getOrgSetting(db, organizationId, "github_features");
}
