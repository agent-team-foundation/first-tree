/**
 * Standard span attribute names used across Hub tracing.
 *
 * Centralized to avoid typos (`inbox.entry.id` vs `inbox_entry_id`) and to
 * make trace-backend queries consistent — operators can search by these keys
 * to correlate spans across inbox enqueue / deliver / ws push / adapter flush
 * without real parent links.
 *
 * Keys follow OTel convention: lowercase dot-separated namespaces.
 */
export const FIRST_TREE_HUB_ATTR = {
  // Multi-tenancy
  ORGANIZATION_ID: "organization.id",
  MEMBER_ID: "member.id",
  AGENT_ID: "agent.id",
  CLIENT_ID: "client.id",

  // Messaging domain
  CHAT_ID: "chat.id",
  CHAT_TYPE: "chat.type",
  MESSAGE_ID: "message.id",
  MESSAGE_SOURCE: "message.source",

  // Inbox
  INBOX_ENTRY_ID: "inbox.entry.id",
  INBOX_ATTEMPT: "inbox.delivery.attempt",
  INBOX_STATUS: "inbox.entry.status",

  // WebSocket
  WS_MESSAGE_TYPE: "ws.message.type",
  WS_MESSAGE_REF: "ws.message.ref",
  WS_CLOSE_CODE: "ws.close.code",
  WS_REMOTE_IP: "ws.remote.ip",

  // Adapter (external IM bridging)
  ADAPTER_PLATFORM: "adapter.platform",
  ADAPTER_ID: "adapter.id",
  ADAPTER_EXTERNAL_CHAT_ID: "adapter.external_chat_id",

  // Kael forwarding
  KAEL_ENDPOINT: "kael.endpoint",

  // Background tasks
  BG_TASK_NAME: "bg_task.name",
  BG_TASK_DURATION_MS: "bg_task.duration_ms",
} as const;

export type FirstTreeHubAttrKey = keyof typeof FIRST_TREE_HUB_ATTR;
export type FirstTreeHubAttrName = (typeof FIRST_TREE_HUB_ATTR)[FirstTreeHubAttrKey];

/**
 * Attribute key patterns considered sensitive — automatically redacted by
 * the telemetry facade when normalizing span attrs. Matched case-insensitively
 * by substring.
 */
export const TRACING_SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "password",
  "token",
  "secret",
  "authorization",
  "apikey",
  "api_key",
  "encryptionkey",
  "encryption_key",
  "jwtsecret",
  "jwt_secret",
  "appsecret",
  "app_secret",
];
