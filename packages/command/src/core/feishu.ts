/**
 * Feishu-related core operations: bind-bot, bind-user.
 */

/**
 * Self-service bind a Feishu bot (agent binds its own bot).
 */
export async function bindFeishuBot(
  serverUrl: string,
  agentToken: string,
  appId: string,
  appSecret: string,
): Promise<void> {
  const res = await fetch(`${serverUrl}/api/v1/agent/me/feishu-bot`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appId, appSecret }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Bind Feishu bot failed: HTTP ${res.status}`);
  }
}

/**
 * Delegate bind a Feishu user (assistant binds owner's Feishu user ID).
 */
export async function bindFeishuUser(
  serverUrl: string,
  agentToken: string,
  humanAgentId: string,
  feishuUserId: string,
  displayName?: string,
): Promise<void> {
  const res = await fetch(`${serverUrl}/api/v1/agent/delegated/${encodeURIComponent(humanAgentId)}/feishu-user`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ feishuUserId, displayName }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Bind Feishu user failed: HTTP ${res.status}`);
  }
}
