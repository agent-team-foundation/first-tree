---
title: Workspace
owners: [Gandy2025]
---

# Workspace

Workspace is Kael's primary durable unit of work. It is the user-facing work area, backed by one backend `Project`, with its own identity, guidance, enabled capabilities, files, and interaction surface.

## Core Model

- Each workspace corresponds to one backend `Project`.
- The project is the durability layer under the workspace: it owns long-lived identity, sessions, assets, and persisted settings.
- Workspace configuration is stored in `project.settings`.
- A workspace is created from a template, but the stored config is a copied snapshot, not a live reference back to the template.
- Session state lives inside the workspace container rather than replacing it. The workspace remains the stable unit a user returns to over time.

## Current Product State

- Workspace creation is template-backed rather than freeform-by-default.
- Templates currently expand into persisted workspace config and provide default guidance, display metadata, and first-message experience copy.
- Workspace capability enablement is expressed through structured config such as native toolsets and skills, not ad hoc prompt text.

## Configuration Protocol

- Persist only stable product semantics. Store fields like `template_id`, `entry_key`, display metadata, enabled skills, and allowed native toolsets.
- `entry_key` is meaningful only for template-backed workspaces.
- Do not persist backend wiring. Broad tool groups and other internal runtime mappings are derived from policy at execution time.
- Keep workspace config narrow. It defines identity, capability boundaries, and light guidance; dynamic environment state stays outside it.

## Runtime Model

- Workspace templates provide the initial identity and configuration for a new workspace.
- Each run reads `project.settings`, resolves it into a runtime view, and derives the effective capability boundary from template policy plus persisted settings.
- Workspace guidance is injected dynamically into the agent prompt together with skills and other per-run context.
- `agents_md` is a behavior supplement for background, terminology, style, and collaboration rules; it does not grant tools or permissions by itself.
- Saving workspace guidance or skills updates the same persisted workspace config that the next run reads.

## Product Surface

- Workspace is the current main work surface where chat, preview, project files, history, and workspace configuration coexist.
- Workspace switching is project-based: the UI can restore the project's main session when re-entering a workspace.
- The workspace info panel is a low-frequency configuration surface over `project.settings`, not a separate system.
- The workspace should remain the stable skeleton while files, browser state, desktop state, message history, and memory stay runtime context.

## Boundaries

- Workspace config does not replace `session.agent_type`.
- Workspace config does not persist model overrides, sub-agent policy, or full tool-group wiring.
- Workspace config should shrink toward a stable product protocol, not grow into a copy of runtime state.
- Detailed route structure, panel sizing, and component composition stay in source systems.

## Cross-Domain Links

- Workspace assets and file identity: [project-asset-system.md](project-asset-system.md)
- Workspace-backed integration entry points: [integrations/NODE.md](integrations/NODE.md)
- User interaction patterns that happen inside the workspace: [../chat/NODE.md](../chat/NODE.md)
