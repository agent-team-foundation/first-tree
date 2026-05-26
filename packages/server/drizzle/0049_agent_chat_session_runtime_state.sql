-- Per-(agent,chat) D-axis runtime state. Historically the runtime state
-- (idle/working/blocked/error) lived only agent-global on
-- `agent_presence.runtime_state`; that granularity is unusable for the
-- per-chat composite status (an agent working in chat A would light chat B —
-- #366), so the composite reconstructed "working" from a decaying
-- `session_events` proxy that fails for long silent turns and for runtimes
-- that emit no intermediate events (codex). These columns give the D-axis
-- its correct per-chat home so the composite reads it directly.
--
-- `runtime_state` defaults to 'idle' so existing rows are well-defined.
--
-- `runtime_state_at` is intentionally NULLABLE with NO default: a NULL marks
-- "client is bound but has not yet sent its first session:runtime frame for
-- this chat" (a transient sentinel between session:state active and the
-- first runtime report). The composite reads NULL as fail-closed (not
-- working / not errored). A now() default would be indistinguishable from a
-- real report and would let the producer light up sessions that never had a
-- runtime frame at all.

ALTER TABLE "agent_chat_sessions"
  ADD COLUMN IF NOT EXISTS "runtime_state" text NOT NULL DEFAULT 'idle';

--> statement-breakpoint
ALTER TABLE "agent_chat_sessions"
  ADD COLUMN IF NOT EXISTS "runtime_state_at" timestamp with time zone;
