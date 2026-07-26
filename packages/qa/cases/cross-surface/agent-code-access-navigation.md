---
id: agent-code-access-navigation
description: Validate the independent Repositories settings page, its code and Context Tree sections, and reliable Agent Detail deep-link positioning.
areas: [cross-surface]
surfaces: [web]
---

# Agent Code Access Navigation

## Goal

Confirm that Settings → Repositories is the provider-neutral home for both
Team code repositories and the separate Context Tree repository binding. The
two models share one repository-oriented destination without sharing state or
credentials. GitHub and GitLab tabs remain connection-only. Validate the real
Agent Detail → Settings navigation through the Web shell's persistent scroll
container and the assembled page's heading hierarchy.

## Preconditions

- Run the target ref in the isolated Docker plus temporary-worktree QA cell.
- Prepare one Team admin, one ordinary member, and a manageable non-human
  agent. Seed at least four recommended Team code repositories using a mix of
  GitHub, GitLab, and another valid Git-server URL.
- Bind a Context Tree repository on its default branch and configure an active
  reviewer agent. Provider connections may be connected or disconnected, but
  record their states before the run. Do not place real private-repository
  credentials in Team resource payloads or QA artifacts.

## Operate and Observe

- As the admin, open Settings → Repositories. Confirm the page has no repeated
  visible **Repositories** heading. **Code repositories** and **Context Tree**
  must be the only peer section headings; repository names and **Automatic PR
  review** must read as lower-level row labels, with URLs, branch, and reviewer
  rendered as quieter metadata.
- Confirm **Code repositories** appears first, with the first three rows visible
  and the fourth behind **View all (4)**. Expand and collapse the list, then add
  or edit a full non-GitHub URL. Verify the catalog updates without requiring a
  GitHub App or GitLab webhook connection.
- In **Context Tree**, confirm the compact binding row shows the repository
  name, full URL, and default branch, with **Edit** and **Open Context** as
  secondary actions. Confirm **Automatic PR review** is a row in this same
  section, not a third section heading, and its saved reviewer is metadata that
  can open the selector.
- Open Settings → Integrations under GitHub and GitLab. Confirm the catalog and
  Context Tree binding do not appear there; the surface contains only
  **Connections** and provider-specific controls.
- As the ordinary member, confirm both Repositories sections remain readable,
  while add, edit, retire, and reviewer mutation controls are unavailable.
- Open the agent's repository-management surface, scroll the persistent main
  pane far enough that preserving the old offset would skip the destination,
  and choose **Manage Team repositories**. Confirm navigation lands on and
  focuses **Code repositories**. Repeat with the legacy Settings → Context URL
  and confirm it lands on and focuses **Context Tree**.
- Confirm the agent's effective repository list reflects recommended Team code
  resources independently of provider connection state. The UI may explain
  that private clone access uses Git credentials on the agent computer; it must
  not imply that provider connection credentials clone code.

## Evidence

Capture the Repositories page hierarchy, compact and expanded code lists, the
Context Tree row, both provider-only Integrations tabs, admin-versus-member
controls, and the positioned deep-link destinations. Record only redacted
repository coordinates and connection summaries; never retain Git tokens,
private clone credentials, or one-time webhook bearers.

## Expected Result

`PASS`: one independent Repositories page presents exactly two visible section
headings in the intended order, preserves both models' role boundaries, keeps
provider tabs connection-only, and reliably positions both current and legacy
deep links.

`FAIL`: the page repeats its own title, promotes a row to section-heading level,
mixes the two repository models, duplicates repository management under a
provider, grants member write controls, or leaves a deep-link destination out
of view.

`BLOCKED`: the isolated run cell cannot create the required Team roles,
manageable agent, repository fixtures, or Context Tree binding.

`INCONCLUSIVE`: source inspection or unit-test output exists, but the assembled
Settings hierarchy and persistent-scroll navigation were not observed in a
browser.
