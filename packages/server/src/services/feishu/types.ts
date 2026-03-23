/** Feishu adapter types (used with @larksuiteoapi/node-sdk). */

// ── Normalized inbound event ────────────────────────────────────────

export type InboundEvent = {
  eventId: string;
  platform: "feishu";
  appId: string;
  senderId: string;
  senderType: string;
  externalChannelId: string;
  chatType: string;
  messageId: string;
  messageType: string;
  content: unknown;
  threadId: string | null;
  mentions: Array<{ key: string; openId: string; name: string }>;
  timestamp: string;
};

// ── Bot credentials stored in adapter_configs ───────────────────────

export type FeishuBotCredentials = {
  app_id: string;
  app_secret: string;
  /** Skip HTTP proxy for SDK connections. Defaults to true (Lark SDK proxy bug workaround). */
  bypass_proxy?: boolean;
};
