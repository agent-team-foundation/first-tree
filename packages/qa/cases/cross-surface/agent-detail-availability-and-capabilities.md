---
id: agent-detail-availability-and-capabilities
description: Validate that Team and Agent Detail communicate one trustworthy availability state and an actionable, permission-aware capability configuration.
areas: [cross-surface]
surfaces: [web, server]
---

# Agent Detail Availability And Capabilities

## Goal

Confirm that a person can identify an agent, decide whether it can receive work,
understand the reason when it cannot, and inspect the Skills and integrations
that apply to it. Team and Agent Detail must project the same four durable
user-facing states without exposing the underlying lifecycle and connection
axes as a health score.

## Preconditions

- Run the target ref against an isolated local stack with one Team admin and one
  ordinary member.
- Prepare manageable agents representing: active with an online assigned
  computer, active with an offline assigned computer, active with no assigned
  computer, and suspended.
- Prepare one Team-default Skill, one Skill enabled only for an agent, one MCP
  integration, and an agent with no Skills or integrations.
- Record the real runtime and binding rows before the run. Do not infer a local
  daemon failure reason that the server does not provide.

## Operate And Observe

- In Team, confirm every agent row shows exactly one primary state: **Online**,
  **Offline**, **Needs setup**, or **Suspended**. Open each row and confirm Agent
  Detail shows the same state, a plain-language cause, and one appropriate
  action without adding a second competing status.
- Confirm **Needs setup** explains that no computer is assigned and offers a
  computer chooser. Confirm **Suspended** takes precedence over connection facts,
  removes the start-chat action, and offers reactivation only to an authorized
  manager when the agent still has a runtime route. For a suspended agent whose
  route was cleared, confirm the header offers the supported runtime chooser
  instead of an impossible Reactivate action. Force reactivation to fail once
  and verify the error and Retry action remain beside the header action only
  while the agent is still eligible for reactivation.
- Confirm the canonical breadcrumb identifies Team and the current agent. On a
  wide viewport, use the sticky local section navigation; on a narrow Web
  viewport, use the section selector. Neither surface may restore the horizontal
  Team avatar strip or a seven-tab scroller.
- In **Tools & skills**, confirm Skills and integrations are separate sections.
  Each configured row must expose its purpose, neutral Enabled/Disabled state,
  effective rule, and origin without implying that an enabled resource makes an
  offline or suspended agent runnable.
- Confirm Agent Detail and the matching Settings resource sections use one
  structural divider below each heading. Empty informational content remains
  flat rather than gaining a nested outline; selectable lists keep one complete
  outer frame with separators only between rows. No edge is doubled, clipped,
  or missing at 100% and 200% zoom.
- As the admin, toggle or add an Agent-level capability and observe
  **Saving… → Saved**. Force a save failure, verify the attempted state remains
  understandable, then reload the latest settings and repeat the narrow control
  action. Confirm the rejected full binding set is never replayed after a
  version conflict. As the ordinary member, confirm the effective configuration
  remains readable while management controls are absent and the page identifies
  the agent's manager or a Team admin as the people who can change it.
- As the admin with a suspended agent, confirm the same controls are unavailable
  for a different stated reason: reactivate the agent to make changes. An empty
  Team catalog must route an authorized admin to the shared Settings resource
  catalog; it must not send a viewer to an unusable management page.
- Navigate from an empty integration state to Settings and confirm the shared
  Resources page opens. Return to the agent and verify the effective capability
  view refreshes rather than showing stale configuration.

## Evidence

Capture the four Team states, their matching detail headers, the failed and
successful reactivation feedback, admin/member/suspended capability states, one
expanded capability provenance view, and the wide plus narrow navigation. Keep
computer names and resource payloads synthetic; do not retain environment
variables, credentials, or MCP secrets.

## Expected Result

`PASS`: Team and Agent Detail agree on one understandable availability state;
recovery and permission boundaries are explicit; the capability view explains
what applies and saves with visible, recoverable feedback; wide and narrow Web
navigation remain usable.

`FAIL`: states conflict across surfaces, a status overclaims its root cause,
Suspended still offers new work, managers are described as viewers, resource
configuration is mistaken for agent health, a mutation fails silently, or an
empty-state action leads to a page the viewer cannot use.

`BLOCKED`: the isolated stack cannot create the required roles, lifecycle
states, runtime presence, or resource bindings.

`INCONCLUSIVE`: source inspection or component tests exist, but the assembled
cross-surface flow was not observed in a browser.
