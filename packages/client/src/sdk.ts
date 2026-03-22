import type { Agent, InboxEntryWithMessage } from "@agent-hub/shared";

export type SdkConfig = {
  serverUrl: string;
  token: string;
};

export type RegisterResult = {
  agentId: string;
  inboxId: string;
  status: string;
  displayName: string | null;
};

export type PullResult = {
  entries: InboxEntryWithMessage[];
  remaining: number;
};

export class AgentHubSDK {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: SdkConfig) {
    // Strip trailing slash
    this.baseUrl = config.serverUrl.replace(/\/+$/, "");
    this.token = config.token;
  }

  /** Validate token, return agent identity. */
  async register(): Promise<RegisterResult> {
    const agent = await this.request<Agent>("/agent/me");
    return {
      agentId: agent.id,
      inboxId: agent.inboxId,
      status: agent.status,
      displayName: agent.displayName,
    };
  }

  /** Fetch pending inbox entries. */
  async pull(limit = 10): Promise<PullResult> {
    const entries = await this.request<InboxEntryWithMessage[]>(`/agent/inbox?limit=${limit}`);
    return {
      entries,
      remaining: 0, // Server doesn't return remaining count yet
    };
  }

  /** Acknowledge an inbox entry. */
  async ack(entryId: number): Promise<void> {
    await this.request(`/agent/inbox/${entryId}/ack`, { method: "POST" });
  }

  /** Renew lease on an inbox entry. */
  async renew(entryId: number): Promise<void> {
    await this.request(`/agent/inbox/${entryId}/renew`, { method: "POST" });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    // Only set Content-Type for requests with a body — Fastify rejects empty JSON bodies
    if (init?.body) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, { ...init, headers });

    if (!response.ok) {
      const body = await response.text();
      let message: string;
      try {
        const json = JSON.parse(body) as { error?: string };
        message = json.error ?? body;
      } catch {
        message = body;
      }
      throw new SdkError(response.status, message);
    }

    // 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

export class SdkError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "SdkError";
  }
}
