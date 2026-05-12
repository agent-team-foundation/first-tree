import {
  AGENT_SELECTOR_HEADER,
  type Agent,
  type AgentRuntimeConfig,
  type Chat,
  type ChatParticipantDetail,
  type ClientCapabilities,
  type InboxEntryWithMessage,
  type Message,
  type RuntimeProvider,
  type SendMessage,
  type SendToAgent,
} from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Callback that returns the current member access JWT.
 *
 * `minValidityMs` lets the caller declare "I need a token still valid for at
 * least N milliseconds." Implementations should refresh whenever the cached
 * token has less than that much life remaining. Without this hint the WS
 * proactive-refresh path would reuse a cached token that is about to expire
 * and immediately get kicked off with `auth:expired`.
 */
export type AccessTokenProvider = (opts?: { minValidityMs?: number }) => string | Promise<string>;

export type SdkConfig = {
  serverUrl: string;
  /**
   * Returns the current member access JWT. Callers are expected to refresh
   * the token transparently (e.g. via a background refresher in the command
   * package). The SDK calls this on every request, so short-lived tokens
   * don't need explicit invalidation here.
   */
  getAccessToken: AccessTokenProvider;
  /**
   * Agent UUID this SDK instance acts on. When set, every request carries
   * `X-Agent-Id`; the server's agent-selector middleware translates that to
   * `request.agent`. Omit for admin/member-only calls (/me, /auth/*).
   */
  agentId?: string;
  /**
   * Optional `User-Agent` header sent on every request. Without it Node's
   * default `User-Agent: node` lands in trace backends — useless for forensics
   * (issue #246). Construction lives in the caller (typically the `command`
   * package's `CLI_USER_AGENT` constant) so the SDK has no compile-time
   * dependency on a specific CLI version or platform discovery.
   */
  userAgent?: string;
};

export type RegisterResult = {
  agentId: string;
  inboxId: string;
  status: string;
  /**
   * Always populated post-Phase 2 of the agent-naming refactor — the server
   * guarantees `agents.display_name` is non-null (migration 0024 + service
   * default) so the client doesn't need a fallback anymore.
   */
  displayName: string;
  type: string;
  delegateMention: string | null;
  metadata: Record<string, unknown>;
};

export type ContextTreeConfig = {
  repo: string | null;
  branch: string | null;
};

export type PullResult = {
  entries: InboxEntryWithMessage[];
};

export type PaginatedResult<T> = {
  items: T[];
  nextCursor: string | null;
};

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Node-level error codes (undici / DNS / TCP) treated as transient by the
 * `doFetch` retry layer. The set covers the failure modes that a *brief*
 * network blip can produce mid-request:
 *
 *   - `ECONNRESET`     — TCP RST mid-stream (commonly a keep-alive idle
 *                        connection closed by the peer and reused before we
 *                        noticed)
 *   - `ETIMEDOUT`      — kernel-level connect/read timeout (peer slow, not
 *                        absent)
 *   - `ENETUNREACH`    — transient routing-table flap (local network reload,
 *                        wifi roam)
 *   - `EAI_AGAIN`      — DNS resolver returned a temporary failure; the
 *                        resolver itself tells us to retry
 *   - `UND_ERR_SOCKET` — undici's internal socket-level error, wrapping the
 *                        above when the request happens through its
 *                        connection pool
 *
 * Deliberately **not** retried at this layer:
 *   - `ECONNREFUSED` — peer is reachable but refusing; retrying immediately
 *                      won't fix anything, and the caller's higher-level
 *                      reconnect logic is the right response
 *   - `ENOTFOUND`    — DNS reports the host doesn't exist (typo or rotated
 *                      record); a 1s retry isn't going to materialise the
 *                      record
 *   - other 4xx-class HTTP statuses — handled by the caller, never reach
 *                                     this set
 */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether an error thrown by `fetch()` represents a transient
 * network-layer failure that the caller should retry.
 *
 * Walks the `cause` chain (undici nests the real reason one level deep via
 * `TypeError("fetch failed").cause`) and checks each link for:
 *   - `message` containing `"fetch failed"` (undici's signature)
 *   - `name === "AbortError"` (our 15s `AbortSignal.timeout`)
 *   - `code` ∈ `RETRYABLE_NETWORK_CODES`
 *
 * `unknown` input is intentional: this function is the gatekeeper for the
 * retry decision in `doFetch`'s catch block, where TS sees `unknown`.
 *
 * Depth is bounded (~5) to defend against the pathological case of a
 * self-referencing cause chain.
 */
function isTransientNetworkError(err: unknown): boolean {
  let current: unknown = err;
  let depth = 0;
  while (current !== null && current !== undefined && depth < 5) {
    if (typeof current !== "object") return false;
    // Narrow `unknown` to a property bag without losing type-safety on the
    // probe sites below. A direct `as` is unavoidable here because the
    // structural shape varies per error library (undici / DNS / our own
    // SdkError), so we cannot derive it from a single typed interface.
    const obj = current as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown };
    if (typeof obj.message === "string" && obj.message.includes("fetch failed")) return true;
    if (obj.name === "AbortError") return true;
    if (typeof obj.code === "string" && RETRYABLE_NETWORK_CODES.has(obj.code)) return true;
    current = obj.cause;
    depth++;
  }
  return false;
}

export class FirstTreeHubSDK {
  private readonly _baseUrl: string;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly _agentId: string | undefined;
  private readonly _userAgent: string | undefined;

  constructor(config: SdkConfig) {
    this._baseUrl = config.serverUrl.replace(/\/+$/, "");
    this.getAccessToken = config.getAccessToken;
    this._agentId = config.agentId;
    this._userAgent = config.userAgent;
  }

  /** Server base URL (without trailing slash). */
  get serverUrl(): string {
    return this._baseUrl;
  }

  /** The agent UUID this SDK is scoped to, if any. */
  get agentId(): string | undefined {
    return this._agentId;
  }

  /** Validate current JWT + X-Agent-Id, return agent identity. */
  async register(): Promise<RegisterResult> {
    const agent = await this.requestJson<Agent>("/api/v1/agent/me");
    return {
      agentId: agent.uuid,
      inboxId: agent.inboxId,
      status: agent.status,
      displayName: agent.displayName,
      type: agent.type,
      delegateMention: agent.delegateMention ?? null,
      metadata: (agent.metadata as Record<string, unknown>) ?? {},
    };
  }

  /** Fetch Context Tree configuration from the server (public endpoint). */
  async getContextTreeConfig(): Promise<ContextTreeConfig> {
    return this.requestJson<ContextTreeConfig>("/api/v1/context-tree/info");
  }

  async fetchAgentConfig(): Promise<AgentRuntimeConfig> {
    return this.requestJson<AgentRuntimeConfig>("/api/v1/agent/config");
  }

  /**
   * Member-scoped: report this client's runtime-provider capabilities. The
   * server stores them under `clients.metadata.capabilities` after checking
   * that the connected member owns the client.
   */
  async updateCapabilities(clientId: string, capabilities: ClientCapabilities): Promise<void> {
    await this.requestVoid(`/api/v1/clients/${encodeURIComponent(clientId)}/capabilities`, {
      method: "PATCH",
      body: JSON.stringify({ capabilities }),
    });
  }

  /**
   * Member-scoped: every agent pinned to a client owned by the calling user.
   * Used by client startup to reconcile the local `agent.yaml::runtime` with
   * the authoritative `agents.runtime_provider` before spawning handlers.
   */
  async listMyAgents(): Promise<Array<{ agentId: string; clientId: string; runtimeProvider: RuntimeProvider }>> {
    return this.requestJson("/api/v1/me/pinned-agents");
  }

  async isHubReachable(timeoutMs = 3_000): Promise<boolean> {
    try {
      const url = `${this._baseUrl}/api/v1/health`;
      // Health is anonymous — can't go through `doFetch` (which calls
      // `getAccessToken`). Stamp UA explicitly so this anonymous probe
      // is grouped with the rest of the install's traffic in trace backends.
      const headers: Record<string, string> = {};
      if (this._userAgent) headers["User-Agent"] = this._userAgent;
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
      return response.ok;
    } catch {
      return false;
    }
  }

  async pull(limit = 10): Promise<PullResult> {
    const entries = await this.requestJson<InboxEntryWithMessage[]>(`/api/v1/agent/inbox?limit=${limit}`);
    return { entries };
  }

  async ack(entryId: number): Promise<void> {
    await this.requestVoid(`/api/v1/agent/inbox/${entryId}/ack`, { method: "POST" });
  }

  async renew(entryId: number): Promise<void> {
    await this.requestVoid(`/api/v1/agent/inbox/${entryId}/renew`, { method: "POST" });
  }

  async sendMessage(chatId: string, data: SendMessage): Promise<Message> {
    return this.requestJson<Message>(`/api/v1/agent/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async sendToAgent(agentName: string, data: SendToAgent): Promise<Message> {
    return this.requestJson<Message>(`/api/v1/agent/agents/${agentName}/messages`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async listChats(options?: { limit?: number; cursor?: string }): Promise<PaginatedResult<Chat>> {
    return this.requestJson(`/api/v1/agent/chats${this.queryString(options)}`);
  }

  async listMessages(chatId: string, options?: { limit?: number; cursor?: string }): Promise<PaginatedResult<Message>> {
    return this.requestJson(`/api/v1/agent/chats/${chatId}/messages${this.queryString(options)}`);
  }

  /**
   * List participants of a chat with agent names/displayNames — used by the
   * runtime to resolve `@<name>` mentions against the authoritative set.
   */
  async listChatParticipants(chatId: string): Promise<ChatParticipantDetail[]> {
    return this.requestJson<ChatParticipantDetail[]>(`/api/v1/agent/chats/${chatId}/participants`);
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

  /**
   * Retry transient network-layer failures and HTTP 5xx with a fixed backoff
   * schedule. Short-term fix for the chat-visible `Result forward failed:
   * fetch failed` errors (see docs/sdk-fetch-retry-design.md): undici's
   * "fetch failed" / `AbortError` / `ECONNRESET`-class errors and any 5xx
   * response trigger up to two retries with `[0, 500ms, 1000ms]` spacing,
   * adding at most ~1.5s of latency beyond the per-attempt 15s timeout.
   *
   * 4xx responses and non-network exceptions are returned/thrown unchanged
   * — they indicate a deterministic failure that retrying cannot fix.
   *
   * Idempotency caveat: `sendMessage` is not natively idempotent, so a
   * `fetch failed` from a request the server actually committed will
   * produce a duplicate message on retry. The design accepts this for now
   * (small window, low rate, mitigated long-term by an Outbox pattern with
   * client-generated UUIDs).
   *
   * The retry signature and externally-visible behaviour match `doFetch`'s
   * pre-retry contract: callers see the same Response on success or the
   * same error type on terminal failure.
   */
  private async doFetch(path: string, init?: RequestInit): Promise<Response> {
    const delays = [0, 500, 1000];
    let lastErr: unknown;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = delays[attempt];
      if (delay !== undefined && delay > 0) {
        await sleep(delay);
      }
      try {
        const response = await this.doFetchOnce(path, init);
        const isLastAttempt = attempt === delays.length - 1;
        if (response.status >= 500 && !isLastAttempt) {
          console.warn(`sdk: retry attempt=${attempt + 1} reason=http-${response.status} path=${path}`);
          lastErr = new Error(`HTTP ${response.status}`);
          continue;
        }
        return response;
      } catch (err) {
        lastErr = err;
        if (!isTransientNetworkError(err)) throw err;
        const isLastAttempt = attempt === delays.length - 1;
        if (!isLastAttempt) {
          const reason =
            err instanceof Error ? (err.name === "AbortError" ? "timeout" : err.message.slice(0, 60)) : "unknown";
          console.warn(`sdk: retry attempt=${attempt + 1} reason=${reason} path=${path}`);
        }
      }
    }
    throw lastErr;
  }

  private async doFetchOnce(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this._baseUrl}${path}`;
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (this._agentId) {
      headers[AGENT_SELECTOR_HEADER] = this._agentId;
    }
    if (this._userAgent) {
      headers["User-Agent"] = this._userAgent;
    }
    if (init?.body) {
      headers["Content-Type"] = "application/json";
    }
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(url, { ...init, headers, signal });
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
