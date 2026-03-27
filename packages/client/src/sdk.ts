import type { Agent, Chat, InboxEntryWithMessage, Message, SendMessage, SendToAgent } from "@first-tree-hub/shared";

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
};

export type PaginatedResult<T> = {
  items: T[];
  nextCursor: string | null;
};

export class FirstTreeHubSDK {
  private readonly _baseUrl: string;
  private readonly _token: string;

  constructor(config: SdkConfig) {
    // Strip trailing slash
    this._baseUrl = config.serverUrl.replace(/\/+$/, "");
    this._token = config.token;
  }

  /** Server base URL (without trailing slash). */
  get serverUrl(): string {
    return this._baseUrl;
  }

  /** Agent bearer token. */
  get agentToken(): string {
    return this._token;
  }

  /** Validate token, return agent identity. */
  async register(): Promise<RegisterResult> {
    const agent = await this.requestJson<Agent>("/api/v1/agent/me");
    return {
      agentId: agent.id,
      inboxId: agent.inboxId,
      status: agent.status,
      displayName: agent.displayName,
    };
  }

  /** Fetch pending inbox entries. */
  async pull(limit = 10): Promise<PullResult> {
    const entries = await this.requestJson<InboxEntryWithMessage[]>(`/api/v1/agent/inbox?limit=${limit}`);
    return { entries };
  }

  /** Acknowledge an inbox entry. */
  async ack(entryId: number): Promise<void> {
    await this.requestVoid(`/api/v1/agent/inbox/${entryId}/ack`, { method: "POST" });
  }

  /** Renew lease on an inbox entry. */
  async renew(entryId: number): Promise<void> {
    await this.requestVoid(`/api/v1/agent/inbox/${entryId}/renew`, { method: "POST" });
  }

  /** Send a message to a chat. */
  async sendMessage(chatId: string, data: SendMessage): Promise<Message> {
    return this.requestJson<Message>(`/api/v1/agent/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /** Send a direct message to another agent. */
  async sendToAgent(agentId: string, data: SendToAgent): Promise<Message> {
    return this.requestJson<Message>(`/api/v1/agent/agents/${agentId}/messages`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /** List chats the current agent participates in. */
  async listChats(options?: { limit?: number; cursor?: string }): Promise<PaginatedResult<Chat>> {
    return this.requestJson(`/api/v1/agent/chats${this.queryString(options)}`);
  }

  /** List messages in a chat. Requires caller to be a participant. */
  async listMessages(chatId: string, options?: { limit?: number; cursor?: string }): Promise<PaginatedResult<Message>> {
    return this.requestJson(`/api/v1/agent/chats/${chatId}/messages${this.queryString(options)}`);
  }

  private queryString(options?: { limit?: number; cursor?: string }): string {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  private async requestVoid(path: string, init?: RequestInit): Promise<void> {
    const response = await this.doFetch(path, init);
    if (!response.ok) {
      throw await this.toSdkError(response);
    }
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.doFetch(path, init);
    if (!response.ok) {
      throw await this.toSdkError(response);
    }
    return (await response.json()) as T;
  }

  private async doFetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this._baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._token}`,
    };
    // Only set Content-Type for requests with a body — Fastify rejects empty JSON bodies
    if (init?.body) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(url, { ...init, headers });
  }

  private async toSdkError(response: Response): Promise<SdkError> {
    const body = await response.text();
    let message: string;
    try {
      const json = JSON.parse(body) as { error?: string };
      message = json.error ?? body;
    } catch {
      message = body;
    }
    return new SdkError(response.status, message);
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
