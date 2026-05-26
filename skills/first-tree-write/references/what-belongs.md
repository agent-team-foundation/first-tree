# What Belongs In The Tree

Write makes one decision over and over: given a source (PR, doc, note),
what — if anything — belongs in the tree?

Use this guide as the judgment filter before drafting any update.

## The One-Line Rule

The tree captures **decisions**, **constraints**, **ownership**, and
**cross-domain relationships**. It does not mirror execution detail.

If the source helps a future agent **decide**, it goes in the tree.
If it helps execute, it stays in the source repo.

## Belongs

- A choice between alternatives (e.g. "we picked Postgres over MySQL
  because…")
- A constraint that shapes future implementation (e.g. "all public APIs
  must support JSON streaming")
- A rule that crosses repos (e.g. "frontend never reads auth state
  directly; always go through the SDK")
- An ownership change or a clarified review path
- A deprecation or supersession (e.g. "legacy gateway is read-only after
  Q3")
- A new relationship between two domains (e.g. "Search now subscribes to
  Indexer events")
- The _rationale_ behind any of the above when it would not be obvious
  from the diff

## Does Not Belong

- Function signatures, types, or class hierarchies
- Step-by-step implementation walkthroughs
- API request/response shapes (those live in the OpenAPI / proto / SDK
  source)
- Test fixtures and snapshot data
- Build / CI / lint configuration
- Bug fixes that do not change a public contract
- Refactors that preserve behavior
- "Performance got better" without a measurable claim worth pinning

If it would rot when the next refactor lands, it does not belong.

## The Decision Test

Apply both questions; the source belongs only if both are yes.

1. **Decision question:** does this source establish or change something a
   future agent must respect when making cross-domain choices?
2. **Durability question:** if this commit were rewritten, would the
   underlying decision still stand?

If question 1 is no, write nothing — point the user at the source
directly.

If question 2 is no, write nothing — the source is implementation detail
that should not be pinned.

## Examples

### Source: a 600-line PR adding a new caching layer

- **Belongs:** the constraint "Service X owns the cache; other services
  must read through Service X's SDK". The decision "we chose Redis over
  Memcached because of pubsub support."
- **Does not:** the cache key format, the eviction policy class, the
  retry constants. Those rot with the next refactor.

### Source: a meeting note "we are moving billing to a new repo"

- **Belongs:** the workspace map gets a new repo; ownership for billing
  shifts; the boundary between `billing/` and `platform/` is updated.
- **Does not:** the migration timeline, the release-day playbook, the
  individual PR list. Those go in an issue or a runbook.

### Source: a reviewer's nit about variable naming

- **Belongs:** nothing. Naming is implementation detail.

### Source: a security review report

- **Belongs:** the constraints that came out of it (e.g. "session tokens
  must be HMAC-signed before storage"). The accountable owner.
- **Does not:** the specific vulnerabilities found and how they were
  patched. Those belong to the security tracking system.

## When In Doubt

Default to **not** writing. The tree should compress expensive context,
not mirror the source repo. A node nobody reads is worse than a missing
node — a missing node is a question; a noisy node is a trap.
