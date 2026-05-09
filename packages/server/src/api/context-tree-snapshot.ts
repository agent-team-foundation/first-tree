import { contextTreeSnapshotSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { ServerConfig } from "@agent-team-foundation/first-tree-hub-shared/config";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../scope/require-user.js";
import { type ContextTreeBinding, getContextTreeSnapshot } from "../services/context-tree-snapshot.js";
import { getOrgContextTree, resolveUserPrimaryOrgId } from "../services/org-settings.js";

const querySchema = z
  .object({
    window: z.enum(["1d", "7d", "30d"]).optional(),
  })
  .strict();

export async function contextTreeSnapshotRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/snapshot",
    {
      config: {
        rateLimit: {
          max: app.config.rateLimit?.contextTreeSnapshotMax ?? 6,
          timeWindow: "1 minute",
          keyGenerator: (request: FastifyRequest): string => request.user?.userId ?? request.ip,
        },
      },
    },
    async (request) => {
      const query = querySchema.parse(request.query);
      const { userId } = requireUser(request);
      const orgId = await resolveUserPrimaryOrgId(app.db, userId);
      const binding: ContextTreeBinding = orgId ? await getOrgContextTree(app.db, orgId) : {};
      const githubToken = contextTreeGithubTokenForRepo(binding.repo, app.config.contextTreeSync);
      const snapshot = await getContextTreeSnapshot({ ...binding, githubToken }, query.window ?? "7d");
      return contextTreeSnapshotSchema.parse(snapshot);
    },
  );
}

type ContextTreeSyncConfig = NonNullable<ServerConfig["contextTreeSync"]>;

export function contextTreeGithubTokenForRepo(
  repo: string | null | undefined,
  syncConfig: ContextTreeSyncConfig | undefined,
): string | undefined {
  if (!repo || !syncConfig?.githubToken) return undefined;
  const repoKey = githubRepoKey(repo);
  if (!repoKey) return undefined;
  const allowedRepos = new Set(
    (syncConfig.githubTokenRepos ?? "")
      .split(",")
      .map((entry) => normalizeGithubRepoKey(entry))
      .filter((entry): entry is string => entry !== null),
  );
  return allowedRepos.has(repoKey) ? syncConfig.githubToken : undefined;
}

function githubRepoKey(value: string): string | null {
  const shorthand = normalizeGithubRepoKey(value);
  if (shorthand) return shorthand;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  if (url.username || url.password) return null;
  return normalizeGithubRepoKey(url.pathname.replace(/^\/+/, ""));
}

function normalizeGithubRepoKey(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "");
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (!match) return null;
  return `${match[1]?.toLowerCase()}/${match[2]?.toLowerCase()}`;
}
