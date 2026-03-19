---
title: Project Asset System
owners: [Gandy2025]
---

# Project Asset System

`project_assets` is Kael's unified asset system for project-scoped files and references. Although it supports retrieval and document workflows, its primary design role is platform-level: it defines file identity, asset types, URI addressing, and sharing behavior across the product.

## Core Model

- Every project-scoped file or reference is represented as a `ProjectAsset`.
- The asset system unifies uploaded documents, generated artifacts, internal derived files, and references to content stored in other systems.
- Asset identity and processing identity are deliberately different: `asset.id` identifies the project-level record, while `content_hash` supports deduplicated processing and sharing behavior.

## Asset Types

- `EXTERNAL`: files entering the project from outside, such as uploads and web downloads.
- `ARTIFACT`: files created inside the project by users or agents.
- `INTERNAL`: system-derived files such as extracted images or rendered slide previews.
- `REFERENCE`: project-visible references to content stored in another system, such as slide records.

## Addressing And Sharing

- `file://` is the canonical ID-based lookup for assets.
- Filename-based schemes such as `external://`, `artifact://`, and `internal://` express the asset's role.
- Legacy `workspace://` paths map to `artifact://`, reflecting that workspace files are first-class project artifacts.
- External files can share parsing results across projects through `content_hash` while keeping separate project-level records.
- Internal derived files are shareable by source asset rather than owned exclusively by one project copy.

## Product Implications

- Web fetch stores a webpage as a normal project asset rather than as a separate side channel.
- The shared URI layer matters because agents, previews, chat rendering, and sandbox access all rely on the same addressing model for project files.
- This system is the file substrate under workspace work, not just a knowledge-processing detail.

## Boundaries

- This node captures the design of the asset system, not the full database schema or API contract.
- Parsing pipelines, chunking details, and storage implementation remain in source systems.
- The asset system defines file identity and platform behavior; retrieval and document understanding systems consume it downstream.

## Cross-Domain Links

- Workspace as the durable unit that owns asset state: [workspace.md](workspace.md)
- Chat and preview surfaces that expose assets to users: [../chat/NODE.md](../chat/NODE.md)
- Knowledge systems that parse and retrieve from these assets: [../knowledge/NODE.md](../knowledge/NODE.md)
