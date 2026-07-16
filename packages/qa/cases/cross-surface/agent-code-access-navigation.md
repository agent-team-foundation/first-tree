---
id: agent-code-access-navigation
description: Validate that Team repository access stays provider-neutral across Settings and Agent Detail, including reliable deep-link positioning from a scrolled Agent page.
areas: [cross-surface]
surfaces: [web]
---

# Agent Code Access Navigation

## Goal

Confirm that Team repository access is one provider-neutral catalog shared by
agents, while GitHub and GitLab connections remain separate event, identity,
and webhook controls. Validate the real Agent Detail → Settings navigation
through the Web shell's persistent scroll container; deterministic DOM tests
own the URL and hash-effect branches, while this case owns the assembled
browser positioning and cross-page information hierarchy.

## Preconditions

- Run the target ref in the isolated Docker plus temporary-worktree QA cell.
- Prepare one Team admin, one ordinary member, and a manageable non-human
  agent. Seed at least four recommended Team repository resources using a mix
  of GitHub, GitLab, and another valid Git-server URL.
- The provider connection states may be connected or disconnected, but record
  them before the run. Do not place real private-repository credentials in the
  Team resource payload or QA artifacts.

## Operate and Observe

- As the admin, open Settings → Integrations under both the GitHub and GitLab
  tabs. Confirm **Code available to agents** is above **Connections**, shows
  the same Team repository catalog on both routes, and does not move into or
  duplicate inside either provider tab.
- Confirm the first three repositories are visible and the fourth is hidden
  behind **View all (4)**. Expand and collapse the list, then add or edit a
  repository with a full non-GitHub URL and verify the shared catalog updates
  without requiring a GitHub App or GitLab webhook connection.
- As the ordinary member, confirm the same shared catalog is readable while
  add, edit, and retire controls remain unavailable. Provider connection
  controls must retain their existing role boundary.
- Open the agent's repository-management surface, scroll the persistent main
  pane far enough that preserving the old offset would skip the top of the
  Settings page, and choose **Manage Team code access**. Confirm navigation
  lands with the shared code section visibly positioned and focused rather
  than leaving the viewport below it. Repeat after visiting both a GitHub and
  a GitLab connection tab.
- Confirm the agent's effective repository list reflects recommended Team
  resources independently of provider connection state. The UI may explain
  that private clone access uses Git credentials on the agent computer; it
  must not imply that webhook or provider-connection credentials clone code.

## Evidence

Capture the before-navigation Agent viewport and the positioned Settings
destination, both provider-tab routes with the same catalog, compact and
expanded list states, and admin-versus-member controls. Record only redacted
repository coordinates and connection summaries; never retain Git tokens,
private clone credentials, or one-time webhook bearers.

## Expected Result

`PASS`: one provider-neutral Team repository catalog appears above provider
connections, role boundaries are preserved, the compact list behaves as
described, and the Agent shortcut reliably positions the shared section from
a deeply scrolled origin page.

`FAIL`: repository management is provider-bound or duplicated, connection
state changes catalog availability, a member gains write controls, or the
Agent shortcut preserves an offset that hides the destination.

`BLOCKED`: the isolated run cell cannot create the required Team roles,
manageable agent, or repository fixtures.

`INCONCLUSIVE`: source inspection or unit-test output exists, but the real
persistent-scroll navigation and assembled Settings hierarchy were not
observed in a browser.
