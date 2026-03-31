/**
 * Feishu-related core operations: search, bind-bot, bind-user.
 */

/**
 * Search Feishu users via Hub server API.
 */
export async function searchFeishuUsers(
  serverUrl: string,
  agentToken: string,
  query: string,
  by: "name" | "email" | "mobile" = "name",
): Promise<{
  users: Array<{ userId: string; name: string; email: string | null; department: string | null }>;
  botUsed: string | null;
}> {
  const url = `${serverUrl}/api/v1/agent/feishu/search?q=${encodeURIComponent(query)}&by=${by}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Feishu search failed: HTTP ${res.status}`);
  }

  return (await res.json()) as {
    users: Array<{ userId: string; name: string; email: string | null; department: string | null }>;
    botUsed: string | null;
  };
}

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
