import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listManagedAgents } from "../api/agents.js";
import { useOrgAgents } from "./use-org-agents.js";

/**
 * Shared hook that builds a UUID → name lookup map from the agents list.
 * Used by pages that display agent UUIDs (delegate mentions, participants, senders, bindings).
 *
 * Two sources merged:
 *   1. `/agents` — org-scoped (current selected org). Covers same-org
 *      teammates and any agent visible via the org roster.
 *   2. `/me/managed-agents` — user-scoped, cross-org. Covers agents the
 *      caller manages in non-default orgs, so a client that hosts agents
 *      from multiple orgs (e.g. the `BOUND AGENTS` panel on the Computers
 *      tab) can resolve every UUID to a real name instead of falling back
 *      to the raw UUID. The org-scoped source wins on collision since it
 *      is the more authoritative view for the currently-selected tenant.
 *
 * Note: limited to 100 agents (API max) for the org-scoped page. For
 * deployments with more agents, this should be replaced with a paginated
 * fetch or a dedicated lookup endpoint.
 */
export function useAgentNameMap(): (uuid: string | null | undefined) => string {
  const { data } = useOrgAgents();
  const { data: managed } = useQuery({
    queryKey: ["managed-agents", "name-map"],
    queryFn: listManagedAgents,
    staleTime: 30_000,
  });

  // Post-Phase 2 of the agent-naming refactor, `displayName` is guaranteed
  // non-null by the DB (migration 0024) and the service-level default.
  // The old `a.displayName ?? a.name ?? a.uuid` fallback chain is gone —
  // any missing label now means the UUID isn't in the cached page (e.g.
  // soft-deleted, org changed mid-session), which we surface as the raw
  // uuid so the caller can at least render something stable.
  return useMemo(() => {
    const map = new Map<string, string>();
    // Cross-org managed agents first — the org-scoped source overwrites
    // them so the more authoritative roster view wins on collision.
    if (managed) {
      for (const a of managed) {
        map.set(a.uuid, a.displayName);
      }
    }
    if (data?.items) {
      for (const a of data.items) {
        map.set(a.uuid, a.displayName);
      }
    }
    return (uuid: string | null | undefined) => {
      if (!uuid) return "—";
      return map.get(uuid) ?? uuid;
    };
  }, [data, managed]);
}

/**
 * Reverse of {@link useAgentNameMap}: resolves an agent's `name` (the @handle
 * slug, which is also its workspace directory name) to its UUID.
 *
 * Used by cross-agent doc preview: a snapshot key carries the OWNER agent's
 * slug (`<ownerSlug>/<chatId>/<rel>`), but the path-based fallback endpoint
 * (`GET /chats/:id/docs/preview`) is keyed by agent UUID. The inline-snapshot
 * path renders straight from cache and needs no UUID, so an unresolved slug
 * (owner not in the loaded roster) is non-fatal — callers fall back to the
 * message sender.
 */
export function useAgentSlugToIdMap(): (slug: string | null | undefined) => string | null {
  const { data } = useOrgAgents();
  const { data: managed } = useQuery({
    queryKey: ["managed-agents", "name-map"],
    queryFn: listManagedAgents,
    staleTime: 30_000,
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    // Cross-org managed agents first; org-scoped roster overwrites on collision
    // (more authoritative for the selected tenant), matching useAgentNameMap.
    if (managed) {
      for (const a of managed) {
        if (a.name) map.set(a.name.toLowerCase(), a.uuid);
      }
    }
    if (data?.items) {
      for (const a of data.items) {
        if (a.name) map.set(a.name.toLowerCase(), a.uuid);
      }
    }
    return (slug: string | null | undefined) => {
      if (!slug) return null;
      return map.get(slug.toLowerCase()) ?? null;
    };
  }, [data, managed]);
}

/**
 * Minimal identity pair surfaced to components that want to render the
 * full `<AgentChip>` (display name + `@name`) instead of a single string.
 * `displayName` is non-null post-Phase 2 of the agent-naming refactor;
 * `name` stays nullable because soft-deleted rows have it cleared.
 *
 * `avatarImageUrl` is the resolved avatar URL (uploaded image, or — for
 * human agents — the backing user's external avatar URL such as GitHub).
 * `null` means the renderer should fall back to color + initial.
 *
 * `avatarColorToken` is the manager-selected hue override (`hue-0..7`).
 * `null` means "auto" — the renderer falls back to a deterministic
 * djb2 hash on the agent UUID. Carrying the token through the identity
 * map keeps the fallback hue in sync between left-rail `ChatRowAvatar`
 * and the message timeline (both feed `resolveAvatarHue(colorToken,
 * seed)`); otherwise a manager override applied to one surface would
 * silently disagree with the other.
 */
export type AgentIdentity = {
  name: string | null;
  displayName: string;
  avatarImageUrl: string | null;
  avatarColorToken: string | null;
};

/**
 * Variant of `useAgentNameMap` that returns the full `{ name, displayName }`
 * pair for a UUID, so callers can feed `<AgentChip>` without re-querying
 * the agents list. Returns `null` when the UUID is missing from both the
 * org-scoped and cross-org caches (soft-deleted, filtered out, or never
 * loaded) — callers render their own fallback.
 *
 * Both sources carry `avatarImageUrl`. The org-scoped `/agents` source
 * wins on collision (it's the more authoritative view for the
 * currently-selected tenant); the cross-org `/me/managed-agents` source
 * fills in agents the caller manages in non-default orgs.
 *
 * Only the org-scoped `/agents` source carries `avatarColorToken` today
 * (the `me/managed-agents` route doesn't project it). Cross-org-only
 * agents therefore get `colorToken=null` and fall back to the
 * deterministic djb2 hash on the UUID — same hue both surfaces would
 * have rendered before this token field existed.
 */
export function useAgentIdentityMap(): (uuid: string | null | undefined) => AgentIdentity | null {
  const { data } = useOrgAgents();
  const { data: managed } = useQuery({
    queryKey: ["managed-agents", "name-map"],
    queryFn: listManagedAgents,
    staleTime: 30_000,
  });

  return useMemo(() => {
    const map = new Map<string, AgentIdentity>();
    if (managed) {
      for (const a of managed) {
        map.set(a.uuid, {
          name: a.name,
          displayName: a.displayName,
          avatarImageUrl: a.avatarImageUrl ?? null,
          // `/me/managed-agents` doesn't project `avatarColorToken`
          // today; cross-org-only agents land on the djb2-hash fallback.
          avatarColorToken: null,
        });
      }
    }
    if (data?.items) {
      for (const a of data.items) {
        map.set(a.uuid, {
          name: a.name,
          displayName: a.displayName,
          avatarImageUrl: a.avatarImageUrl ?? null,
          avatarColorToken: a.avatarColorToken ?? null,
        });
      }
    }
    return (uuid: string | null | undefined) => {
      if (!uuid) return null;
      return map.get(uuid) ?? null;
    };
  }, [data, managed]);
}
