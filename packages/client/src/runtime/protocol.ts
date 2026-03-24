import { z } from "zod";

// ---------------------------------------------------------------------------
// Runtime → Agent subprocess (written to child stdin)
// ---------------------------------------------------------------------------

export type SessionInitMessage = {
  type: "session_init";
  agent: { agentId: string; displayName: string | null };
  chatId: string;
  chatType: string;
};

export type InboundMessage = {
  type: "message";
  entryId: number;
  chatId: string;
  message: {
    id: string;
    senderId: string;
    format: string;
    content: unknown;
    metadata: Record<string, unknown>;
    inReplyTo: string | null;
    createdAt: string;
  };
};

export type ShutdownMessage = {
  type: "shutdown";
};

export type RuntimeMessage = SessionInitMessage | InboundMessage | ShutdownMessage;

// ---------------------------------------------------------------------------
// Agent subprocess → Runtime (read from child stdout)
// ---------------------------------------------------------------------------

const readyOutputSchema = z.object({ type: z.literal("ready") });

const replyOutputSchema = z.object({
  type: z.literal("reply"),
  entryId: z.coerce.number(),
  format: z.string().optional(),
  content: z.unknown(),
});

const sendOutputSchema = z.object({
  type: z.literal("send"),
  to: z.object({
    chatId: z.string().optional(),
    agentId: z.string().optional(),
  }),
  format: z.string().optional(),
  content: z.unknown(),
});

const ackOutputSchema = z.object({
  type: z.literal("ack"),
  entryId: z.coerce.number(),
});

const renewOutputSchema = z.object({
  type: z.literal("renew"),
  entryId: z.coerce.number(),
});

export const agentOutputSchema = z.discriminatedUnion("type", [
  readyOutputSchema,
  replyOutputSchema,
  sendOutputSchema,
  ackOutputSchema,
  renewOutputSchema,
]);

export type AgentOutput = z.infer<typeof agentOutputSchema>;
export type ReplyOutput = z.infer<typeof replyOutputSchema>;
export type SendOutput = z.infer<typeof sendOutputSchema>;
