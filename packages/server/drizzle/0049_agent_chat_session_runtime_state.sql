-- Per-(agent,chat) D-axis runtime state. Historically the runtime state
-- (idle/working/blocked/error) lived only agent-global on
-- `agent_presence.runtime_state`; that granularity is unusable for the
-- per-chat composite status (an agent working in chat A would light chat B —
-- #366), so the composite reconstructed "working" from a decaying
-- `session_events` proxy that fails for long silent turns and for runtimes
-- that emit no intermediate events (codex). These columns give the D-axis its
-- correct per-chat home so the composite can read it directly.
--
-- `runtime_state` defaults to 'idle' so existing rows are well-defined.
--
-- `runtime_state_at` is intentionally NULLABLE with NO default: a NULL marks
-- "this client has never reported per-chat runtime" (an old client), which is
-- the sole signal the composite uses to fall back to the legacy event proxy
-- for one release cycle. A now() default would be indistinguishable from a
-- real report and would defeat that fallback.

ALTER TABLE "agent_chat_sessions"
  ADD COLUMN IF NOT EXISTS "runtime_state" text NOT NULL DEFAULT 'idle';

--> statement-breakpoint
ALTER TABLE "agent_chat_sessions"
  ADD COLUMN IF NOT EXISTS "runtime_state_at" timestamp with time zone;
