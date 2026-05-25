import { AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { cliFetch } from "./cli-fetch.js";

/**
 * Feishu-related core operations: bind-bot, bind-user.
 *
 * All agent-scoped calls carry both the member access JWT (Authorization)
 * and the acting agent UUID (X-Agent-Id); the server's agent-selector
 * middleware enforces Rule R-RUN.
 */

export async function bindFeishuBot(
  serverUrl: string,
  accessToken: string,
  agentId: string,
  appId: string,
  appSecret: string,
): Promise<void> {
  const res = await cliFetch(`${serverUrl}/api/v1/agent/me/feishu-bot`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      [AGENT_SELECTOR_HEADER]: agentId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appId, appSecret }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Bind Feishu bot failed: HTTP ${res.status}`);
  }
}

export async function bindFeishuUser(
  serverUrl: string,
  accessToken: string,
  agentId: string,
  humanAgentId: string,
  feishuUserId: string,
  displayName?: string,
): Promise<void> {
  const res = await cliFetch(`${serverUrl}/api/v1/agent/delegated/${encodeURIComponent(humanAgentId)}/feishu-user`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      [AGENT_SELECTOR_HEADER]: agentId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ feishuUserId, displayName }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Bind Feishu user failed: HTTP ${res.status}`);
  }
}
