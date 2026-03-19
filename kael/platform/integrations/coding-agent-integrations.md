---
title: Coding Agent Integrations
owners: [Gandy2025]
---

# Coding Agent Integrations

Kael can delegate complex programming work to external CLI coding agents while keeping Kael as the only user-facing agent. The current implemented delegation path is centered on Claude Code.

## Core Model

- The user talks to Kael, not directly to the external coding agent.
- Kael chooses delegation when a task benefits from a specialized coding agent with project-aware editing and tool use.
- The first implementation runs only inside an isolated E2B sandbox.

## Current Product Truth

- Claude Code is the current coding-agent provider that this integration is designed around.
- Use the existing `sandbox_run` path instead of introducing a separate top-level tool just for coding-agent delegation.
- Store both OAuth credentials and API keys for Claude when available: OAuth is the primary path, API key is the fallback path.
- Manage credentials through the account integrations surface rather than ad hoc prompts during task execution.
- The credential substrate is broader than coding agents alone. It is generic enough to support other providers such as GitHub, but that does not mean those providers are current coding-agent delegation paths.

## Execution Model

- Credentials are injected when a sandbox is created or resumed, not on every individual command.
- OAuth-backed credentials are materialized in the sandbox's CLI-specific credential format; API keys are injected as environment variables.
- Kael streams terminal output back to the user while still summarizing and owning the overall interaction.

## Extension Boundary

- The credential model and provider abstraction are intentionally generic so future coding-agent providers can plug into the same pattern.
- Gemini CLI and Codex CLI should be treated as future extension directions, not current tree-level product truth, until their provider integration and delegation path are actually implemented.

## Security And Boundaries

- The permission model relies on sandbox isolation rather than repeated interactive approval inside the delegated CLI.
- This integration extends execution capability, but it does not replace Kael's own orchestration, memory, or chat surface.
- Desktop execution may exist later, but the design starts from sandbox-only execution to keep the trust boundary narrow.

## Cross-Domain Links

- Sandbox execution environment: [../../environment/NODE.md](../../environment/NODE.md)
- Workspace context delegated tasks run inside: [../workspace.md](../workspace.md)
