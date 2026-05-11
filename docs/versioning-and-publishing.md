# Versioning & Publishing

A release reaches downstream consumers only when the published package's
`version` advances. The npm registry refuses to overwrite an existing
version, and `npm ci` resolves strictly by the version pin — so a new
build that ships under an unchanged version is invisible to anyone
running `npm ci` / `npm install`. Treat the version bump as a required
part of every shipped change, not a release-time afterthought.

## Which package's version actually ships

Two packages are published to npm; the rest are `private: true` and
bundled into the published artifacts at build time via `tsdown`. The
private packages' `version` fields are inert — bumping them has no
effect on what downstream consumers receive.

| Package | Path | Published | Bump rule |
|---|---|---|---|
| `@agent-team-foundation/first-tree-hub` | `packages/command` | Yes (`publishConfig.access: public`) | **Bump on every PR that changes `command` or `client` source, or `shared` modules actually imported by `command` / `client`.** This tarball is the unified CLI consumers install — only changes that flow through it need a new version. |
| `@agent-team-foundation/first-tree-hub-shared` | `packages/shared` | Yes | **Bump when the externally-importable surface of `shared` changes** — exported Zod schemas, types, or constants that another npm package could consume. Internal-only edits to `shared` may still require the `command` bump above (if `command` / `client` import them); they do not require a `shared` bump. |
| `@first-tree-hub/client` | `packages/client` | No (`private: true`) | Do not bump — version is inert. Bump `command` instead. |
| `@first-tree-hub/server` | `packages/server` | No (`private: true`) | Do not bump — version is inert. Server reaches users via the docker image and SaaS cloud deploy, **not via the npm tarball**. Server-only changes (and `shared` modules consumed only by server) therefore do not require a `command` bump. |
| `@first-tree-hub/web` | `packages/web` | No (`private: true`) | Do not bump — version is inert. Web reaches users via docker / cloud deploy, not npm; same rule as `server`. |

### When does a `shared` change require a `command` bump?

`shared` is a single package but its modules split into two consumer
camps:

- **`command` / `client` consumers** — types and Zod schemas imported by the CLI or the agent runtime (e.g. agent runtime config, websocket frames, organization schemas surfaced through `/me`). Changes here **must** bump `command`.
- **`server` / `web` consumers only** — admin-API contract schemas, server-config Zod, server-internal types, web-only output shapes. Changes here ship via docker / cloud and **do not** need a `command` bump.

When unsure, grep `packages/command/src` and `packages/client/src` for the export name. No hits → server/web-only → no bump.

## Choosing the next version

1. Read the **published** `latest` from the registry — it may be ahead of
   `main` if a release shipped between PRs:
   ```bash
   npm view @agent-team-foundation/first-tree-hub version
   ```
2. Pick `max(npm latest, current main) + 1` patch — never reuse a
   version that already exists on npm.
3. Default to **patch** bumps for additive changes, fixes, and internal
   refactors. Reserve **minor** bumps for breaking changes to the CLI's
   public surface (commands, flags, exit codes, on-disk file layouts
   under `~/.first-tree/hub/`).
4. Apply the same rule to `shared`: query npm, pick the next available
   patch, prefer patch over minor.

## Anti-pattern

Bumping a `private: true` package (`client` / `server` / `web`) on a PR
that changes its source. pnpm publish only ships `command` and `shared`,
and `tsdown` inlines the private packages into the `command` tarball at
build time — so the private package's `version` field never reaches the
registry. Bump **`packages/command`** instead; that is the artifact
whose version pins the release downstream `npm ci` will see.
