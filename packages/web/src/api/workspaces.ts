import type {
  CreateWorkspaceRequest,
  InvitePreview,
  JoinWorkspaceRequest,
  SwitchOrganizationRequest,
  WorkspaceListItem,
} from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

/**
 * Frontend client for the SaaS workspace + auth surface added by the
 * server-side onboarding PR (`/me/workspaces*`, `/auth/switch-org`,
 * `/invite/:token/preview`).
 * Mirrors the backend routes one-to-one — no business logic here, the
 * server is the source of truth for membership invariants.
 */

export type WorkspaceMutationResult = {
  workspace: { organizationId: string; memberId: string; role: "admin" | "member" };
  accessToken: string;
  refreshToken: string;
};

export type JoinWorkspaceResult = WorkspaceMutationResult & { alreadyMember: boolean };

export async function listMyWorkspaces(): Promise<WorkspaceListItem[]> {
  const { items } = await api.get<{ items: WorkspaceListItem[] }>("/me/workspaces/");
  return items;
}

export async function createWorkspace(input: CreateWorkspaceRequest): Promise<WorkspaceMutationResult> {
  return api.post<WorkspaceMutationResult>("/me/workspaces/", input);
}

export async function joinWorkspace(input: JoinWorkspaceRequest): Promise<JoinWorkspaceResult> {
  return api.post<JoinWorkspaceResult>("/me/workspaces/join", input);
}

export async function switchOrganization(
  input: SwitchOrganizationRequest,
): Promise<{ accessToken: string; refreshToken: string }> {
  return api.post("/auth/switch-org", input);
}

/**
 * Public preview — no Authorization header. Designed to be called from the
 * /invite/:token landing page so we can render "Join Acme Engineering"
 * before forcing the user through GitHub OAuth.
 */
export async function previewInvite(token: string): Promise<InvitePreview> {
  const res = await fetch(`/api/v1/invite/${encodeURIComponent(token)}/preview`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("This invite link isn't valid. Ask your admin for the correct link.");
    }
    throw new Error(`Invite preview failed (${res.status})`);
  }
  return (await res.json()) as InvitePreview;
}
