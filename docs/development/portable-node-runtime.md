# Portable Node Runtime Policy

First Tree's portable installer ships a bundled Node.js runtime inside each
portable release artifact:

```text
<prefix>/versions/<version>/
  node/   # bundled Node.js runtime
  app/    # built CLI package
```

Portable users do not depend on the Node.js version installed on the host
machine. Each portable self-update installs the target release artifact into a
new `versions/<version>` directory, switches `current`, rewrites the shims, and
lets the service manager restart through the shim. The restarted process then
uses the Node.js runtime bundled with the target artifact.

## Ownership

The Distribution / Portable Node owner owns the bundled Node.js policy and bump
PRs. The current Context Tree owner for portable Node distribution is
`bestony`. Normal repository CODEOWNERS still apply for review, but the owner
of this area is responsible for noticing when the runtime line must move and
for cutting a First Tree release when a Node patch needs to reach portable
users.

## Pin Location

The release-default bundled Node.js line is:

```js
// scripts/portable/build-portable.mjs
export const DEFAULT_NODE_VERSION = "latest-v24.x";
```

The portable smoke job also passes an explicit `--node-version latest-v24.x` in
`.github/workflows/ci.yml`. A major bump PR must update both locations in the
same change so CI exercises the candidate line before release.

`latest-v<major>.x` is resolved against `https://nodejs.org/dist/index.json` at
portable artifact build time. That means each published First Tree artifact
contains the newest patch in the configured major line at the time the release
was built. Pass an exact `--node-version` only for one-off validation or release
rehearsal.

## Bump Triggers

Bump the bundled Node.js major when any of these is true:

- The currently bundled major is approaching end of life and the next supported
  major has had enough staging exposure.
- First Tree needs a runtime or dependency feature that is only supported on a
  newer Node.js major.
- A Node.js security advisory makes staying on the current major an unacceptable
  risk, or the fixed line requires moving majors.

Patch-level security fixes are coupled to First Tree releases. Because
`latest-v<major>.x` resolves during artifact build, portable users receive a
new Node.js patch only when a new First Tree portable release is cut. For a
high-impact Node.js advisory that affects the bundled major, cut a First Tree
release even if the app code did not otherwise need one.

## Cross-Major Verification

Before the first real bump to a new Node.js major, run the automated portable
handover test and the portable artifact smoke:

```bash
pnpm --filter first-tree-dev test -- update-portable-install
pnpm --filter first-tree-dev test -- portable-builder
```

The handover test covers the critical invariant: an old portable install can
run the updater while the target artifact contains a different bundled Node.js
major, because the new runtime is not executed in place before the symlink
switch and service restart.

For release rehearsal, build a staging portable artifact with the candidate
Node line, update an older staging portable install to it, then verify:

- `$FIRST_TREE_HOME` still points through the channel shim.
- `<prefix>/current/INSTALL.json` records the candidate `nodeVersion`.
- `first-tree-staging status` reports the target CLI version after restart.

## npm-Mode Runtime Policy

The npm global install path remains supported for operators and fallback
installs, but npm mode uses the user's system Node.js runtime. It does not and
cannot replace Node.js during `first-tree upgrade`.

Before npm-mode self-update runs `npm install -g`, the CLI performs a
best-effort metadata preflight against the target package's `engines.node`.
When the current process Node.js version does not satisfy the target package's
range, the update fails before install with guidance to either:

- upgrade the system Node.js runtime and rerun `first-tree upgrade`; or
- migrate to the portable install path from the web console.

If npm metadata cannot be read, the CLI falls back to the existing npm install
path and classifies npm's own error output. `EBADENGINE` remains a permanent
operator-action failure.
