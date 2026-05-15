# GitHub Entity ↔ Chat Binding — Design

Source of truth for how a Hub chat learns to "own" the GitHub PRs and
Issues that flow through it. Touches `github_entity_chat_mappings` and the
webhook → audience → delivery pipeline.

## Problem framing

Stripped down, the problem is generic:

> A write to a GitHub entity happened from inside chat C. How do future
> webhooks for that entity get routed back to C instead of forking a new
> chat?

The framing matters: "agent ran `gh pr create`" is *one* way the write can
happen, not the only one. The long-term design space has four families:

| Family | Where the binding signal comes from | Coverage | Cost | Robustness |
|---|---|---|---|---|
| **A. Explicit declaration** | Agent calls a Hub-provided `bind_chat_to_github_entity(url)` API after the write | Whatever agents are taught to call | Medium (teach the agent) | Strong (structured input) |
| **B. Outbound proxy** | All agent → GitHub traffic flows through Hub's installation token / proxy; binding is a side-effect of the outbound write | Near-total | High (forcing traffic shape) | Strong |
| **C. Webhook backfill** | When `*.opened` arrives, reverse-look-up recent chat activity in a time window | Generic, no per-tool work | Medium (heuristic + indexes) | Fuzzy (may misbind) |
| **D. Tool-call stdout extraction** | Regex against `resultPreview` of a whitelisted tool | Whatever extractors get written | Low | Brittle (string-level coupling) |

**Target shape**: A is the main path, B is the audit floor, C is the
safety net, D demotes to a fallback for tools we can't influence.

## What ships today (Phase 1)

Pure family **D**, scoped tight: only `Bash gh pr create` and `Bash gh
issue create` are recognised. Both emit a single-line URL on stdout which
fits the 400-char `resultPreview` cap with no information loss.

Pipeline:

1. **Client** (AgentRuntime) — runs the tool, reports `session:event`
   with `kind="tool_call"`, `status="ok"`, `resultPreview="<url>"` over
   the existing WebSocket frame. No client-side parsing.
2. **Server** — `sessionEventService.appendEvent` writes the event row
   and, on `kind="tool_call" && status="ok"`, fires
   `maybeBindGithubEntityFromToolCall` fire-and-forget:
   - `extractGithubEntity` (whitelist parser) → `(entityType, entityKey)`
   - `resolveBindingPair` → `(org, representative_human, delegate)`
   - `insertMappingIfAbsent` with `boundVia="agent_created"`
3. **Webhook arrives** — `pull_request.opened` from `<app-slug>[bot]`.
   `resolveAudience` finds the existing mapping in the subscribed path
   and routes the card to the same chat.

Schema unchanged. `bound_via` is `text` with no CHECK, so the new
`"agent_created"` literal is an application-layer extension only.

### Defensive scaffolding

Even though family D ships first, the data model is set up so future
families can plug in without rewrites:

- **`bound_via` open-ended** — adding `agent_declared` (family A) or
  `outbound_proxy` (family B) is a string literal change. No migration.
- **`resolveBindingPair` is entry-point-agnostic** — any new caller
  (HTTP endpoint for family A, proxy hook for family B) reuses it.
- **`insertMappingIfAbsent` + composite PK** — multiple binding sources
  can coexist without dedup logic; the loser of a race re-reads the
  winner's row.
- **`resolveTargetChat` creation-event guard** — opened webhooks with no
  mapping + no mention return `null`. `isMentionMatched` is required (not
  optional) so any future caller has to make an explicit fail-closed
  decision.
- **`our-app-bot` echo branch** — keeps `kind: "existing"` so Hub's own
  outbound writes still route through the subscription path; drops
  `kind: "new"` so they don't mint a chat to echo themselves.

## Why D is acceptable as the Phase 1 entry point

- Zero client work — every existing AgentRuntime already reports
  `session:event` frames over WS. No SDK version bump.
- Covers the 80% case (`gh pr create`) on day one.
- Failure mode is "binding doesn't happen" — the legacy
  fresh-chat-on-opened path still works, so the worst case is the
  pre-PR behaviour, not a regression.
- The whitelist is honest about its limits — anything not on it falls
  through without misbinding.

## What's explicitly *not* the long-term plan

Adding more extractors (curl, GitHub MCP, …) layers stdout-parsing on
top of stdout-parsing. The brittleness compounds rather than cancels.
Phase 2 deliberately does *not* commit to "extend D forever"; it
delineates the boundary where family A starts paying off.

## Phase 2 candidates (data-driven)

Driven by what telemetry shows once Phase 1 is in staging:

1. **`webhook_arrived_without_mapping` counter**, scoped to
   `(eventType, action) ∈ {(pull_request, opened), (issues, opened)}` and
   sender = our App bot. Quantifies the family-A gap — high count means
   agents are creating entities through paths D doesn't cover.
2. **`resultPreview` cap bump** to ~2 KB *or* a `resultFull` field for
   whitelisted tool kinds. Unblocks curl + MCP without forcing every
   session event payload to bloat.
3. **Family A intro**: a small `POST /api/agents/me/github-entity-binding`
   endpoint the agent can call right after a non-`gh` GitHub write. Agent
   prompt nudge in parallel.
4. **Async GitHub API verification** to garbage-collect "ghost mappings"
   where the agent wrote a syntactically valid but non-existent URL into
   `resultPreview`.

## Open questions

- **Race window**: tool_call ok → DB insert is sub-ms, GitHub webhook
  delivery is ~100ms+. The mapping should win deterministically, but
  Phase 1 doesn't measure it. If the counter above shows non-trivial
  loss, a `pending_creation` short-TTL table (B-flavoured pre-occupy)
  comes back as an option.
- **Group chat ergonomics**: the representative-human pick is
  deterministic (delegateMention-linked first, id-sorted fallback). If
  product wants the card to surface "PR opened by <X>" with X = actual
  GitHub author, that lives in the card builder, not the mapping row.

## File map

| Concern | File |
|---|---|
| Whitelist parser | `packages/server/src/services/github-entity-extractor.ts` |
| Binding service + guard | `packages/server/src/services/github-entity-chat.ts` |
| Session-event hook | `packages/server/src/services/session-event.ts` |
| Audience echo branch | `packages/server/src/services/github-audience.ts` |
| Delivery null handling | `packages/server/src/services/github-delivery.ts` |
| Mapping schema | `packages/server/src/db/schema/github-entity-chat-mappings.ts` |
