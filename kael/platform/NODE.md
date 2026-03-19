---
title: Platform
owners: []
---

# Platform

Cross-cutting infrastructure — auth, identity, projects, workspace, integrations, billing, safety.

## Subdomains

- **[auth/](auth/)** — authentication architecture: user identity (BetterAuth), frontend-to-backend auth, device JWT tokens
- **[security/](security/)** — security posture, known issues (S1-S16), and proposed solutions
- **[agent-security/](agent-security/)** — agent threat model, context filtering, sandbox credential exposure
- **[integrations/](integrations/)** — external systems Kael connects to: IM channels, coding agents, and credential-backed integrations

## Nodes

- [workspace.md](workspace.md) - workspace as Kael's durable unit of work: backend container, configuration protocol, runtime resolution, and product surface.
- [project-asset-system.md](project-asset-system.md) - the unified asset system for project-scoped files, references, URI addressing, and cross-project sharing.
