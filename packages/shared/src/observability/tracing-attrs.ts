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
export const FIRST_TREE_ATTR = {
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
  BG_TASK_CLAIMED_COUNT: "bg_task.claimed_count",
  BG_TASK_SENT_COUNT: "bg_task.sent_count",
  BG_TASK_ERROR_COUNT: "bg_task.error_count",

  // Request identity (HTTP root span)
  USER_ID: "user.id",
  USER_ROLE: "user.role",
  HTTP_USER_AGENT: "http.user_agent",
  HTTP_REQUEST_ID: "http.request.id",
  HTTP_CLIENT_IP: "client.ip",
  HTTP_REFERER: "http.referer",
  HTTP_REQUEST_BODY: "http.request.body",

  // Error semantics
  ERROR_TYPE: "error.type",
  ERROR_CODE: "error.code",
} as const;

export type FirstTreeAttrKey = keyof typeof FIRST_TREE_ATTR;
export type FirstTreeAttrName = (typeof FIRST_TREE_ATTR)[FirstTreeAttrKey];

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
  // OAuth / 2FA / credential-style identifiers — must not leak via body capture.
  // Substring match: keep these narrow enough that legitimate identifiers
  // (`session.id`, `webhook_url`) are not accidentally redacted.
  "otp",
  "pin",
  "credential",
  "passcode",
  "session_token",
  "session_secret",
  "cookie",
];
