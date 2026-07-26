---
id: agent-context-tree-binding-write
description: Validate that the CLI writes only the selected agent organization's Context Tree binding through the agent-derived admin endpoint.
areas: [cross-surface]
surfaces: [cli, client, server]
---

# Agent Context Tree Binding Write

## Goal

Confirm that `first-tree org context-tree set` resolves the same local agent as
the read command, derives that agent's organization through
`GET /api/v1/agent/me`, and performs exactly one admin-only Class B Context Tree
settings update. The command must never target the user's primary or
web-selected organization or consult local Context Tree state. Verify direct
replacement, branch preservation and replacement, strict input validation,
response normalization, and failure classification.

This crosses CLI selection, authentication/runtime-session delivery, SDK
request sequencing, server scope and ACL, and multi-organization state, so
formal QA is warranted before release. Adding this case does not start or
record a formal QA run; execute it only when a human requests formal QA through
the package's isolated run flow. Deterministic tests own schemas, exact
envelopes, and pure error mapping. This case owns live HTTP sequencing,
authorization, and cross-organization evidence.

Deterministic CLI tests own proving that local validation does not create an
SDK or refresh credentials. Deterministic SDK tests own re-reading a rotated
runtime-session token and URL-encoding an arbitrary organization ID. This
black-box case does not claim evidence for those internal behaviors.

## Preconditions

- Run the target refs in an isolated Docker plus temporary git-worktree cell
  with a live PostgreSQL database, candidate server, and candidate CLI. Do not
  reuse the operator's First Tree home, credentials, workspace, or hosted
  organizations.
- Create throwaway organizations A and B and a throwaway user whose primary
  organization is A. Configure local agent `alpha` in A and local agent `beta`
  in B. The success identity must be an organization administrator in B (it
  may be an ordinary member of A). For the 403 check, prepare a separate
  non-admin identity in B with its own locally configured agent that belongs to
  B, is pinned to that identity's client, and is eligible for agent runtime
  access. Verify that this fixture can complete `GET /api/v1/agent/me`; the
  identity must lack only the organization-admin permission needed by the
  settings PUT. Seed A and B with distinct bound repositories and branches.
- Prepare a run-local database fixture step that can replace B's setting with
  an invalid historical string value after the normal binding scenarios. This
  direct fixture mutation is permitted only inside the isolated run cell and
  must not target a real organization.
- Use throwaway syntactically valid HTTPS, `ssh://`, and scp-like SSH
  repository coordinates. No clone or external Git provider access is needed.
  Place a valid but deliberately conflicting Context Tree checkout, workspace
  manifest, and repository metadata in the run working directory to prove
  that local state is ignored.
- Capture outbound HTTP method, path, selected-agent headers, request body,
  response status, and request count at a redacting proxy or candidate-server
  boundary. Never retain JWTs, runtime-session tokens, cookies, credentials,
  raw response bodies, or full unredacted private repository coordinates in
  artifacts.

Fixture creation and mutations are allowed only inside the isolated run cell.
The QA role must not mutate a real user's organizations, bindings, agents, or
local checkout.

## Operate

- With `alpha` and `beta` configured, run
  `first-tree org context-tree set <repo> --branch <new-branch> --agent beta`
  as the B administrator in human and JSON modes. Keep
  `FIRST_TREE_AGENT_ID` pointed at alpha for one invocation to prove that an
  explicit `--agent beta` wins. Run an environment-selected beta invocation
  and, in a task-local home containing only beta, a unique-local-agent
  invocation when the run-local plan needs those selector branches.
- Exercise JSON selected by both `--json` and `FIRST_TREE_JSON=1`; capture
  stdout and stderr separately and verify that JSON mode emits no human status
  lines.
- Rebind B directly to a second repository without a `--rebind` flag. Run a
  repo-only update and verify that it preserves the branch in effect
  immediately before that request, including when an earlier invocation has
  already changed the branch; then provide `--branch` and verify that it is
  replaced. Capture request bodies for both forms.
- Read B through the existing agent-scoped read command and read A separately
  after each mutation. B must change as requested; A must remain byte-for-byte
  unchanged. Keep the conflicting local checkout and manifest in place for all
  reads and writes.
- Exercise every accepted repository form and invalid repo/branch input:
  HTTP, `git://`, malformed URL separators, embedded credentials, query or
  fragment components, backslashes or local drive paths, missing host or path,
  surrounding whitespace, control characters, empty branch, padded branch,
  multiline branch, and Git-invalid branch forms such as `feature..next`,
  `.hidden`, `release.lock`, `topic~1`, and `--bad`. Include `--org` to prove
  that the new command rejects it. These failures must occur without network
  access. Exact schema behavior and the absence of SDK construction or
  credential refresh are owned by deterministic tests.
- In task-local homes, exercise the four selector failures
  (`MISSING_AGENT`, `AMBIGUOUS_AGENT`, `ENV_AGENT_NOT_LOCAL`, and
  `UNKNOWN_AGENT`) and confirm exit `2` with no request. Return an invalid or
  empty `organizationId` from `GET /api/v1/agent/me` and confirm that no PUT
  or partial settings update follows.
- As the non-admin B identity, exercise 403. Also exercise 401, other HTTP and
  5xx responses, invalid or inconsistent responses, connection failure, and
  timeout at the run-cell boundary. For a response where PUT completion is
  unknown, verify that the command directs the operator to rerun the read
  command and does not claim success. Inject a retry-looking condition and
  confirm that PUT is sent once per invocation; existing GET retry behavior may
  remain enabled.
- Remove or downgrade the caller's B admin membership
  between two attempts and confirm that the server rejects the write without a
  partial settings update.
- After the normal write scenarios, inject an invalid historical B row (for
  example, an HTTP repo plus a Git-invalid branch). Confirm that the admin-only
  `GET /api/v1/orgs/<orgId>/settings/context_tree/raw` retains the repair view,
  while the member-safe settings GET returns a sanitized 409 and agent-scoped
  info/read, snapshot, and an isolated runtime startup all treat it as inactive
  and do not attempt a clone.
  Attempt a repo-only repair and
  verify rejection with the row value and version unchanged, then provide both
  a valid repo and branch and verify that every active projection recovers.

## Observe

- A successful invocation sends exactly an agent-scoped
  `GET /api/v1/agent/me` followed by one
  `PUT /api/v1/orgs/<derived-org-id>/settings/context_tree`. Both requests
  carry the selected agent identity and valid authorization. No request reaches
  `/api/v1/me`, a legacy Context Tree endpoint, a web-selected organization, or
  a local workspace source. Deterministic SDK tests own arbitrary organization
  ID encoding and dynamic runtime-session token reload behavior.
- The PUT body is exactly `{ "repo": "..." }` when `--branch` is omitted and
  includes `branch` only when it is provided. The response is `bound`, echoes
  the requested repository, and echoes a provided branch. A repo-only response
  preserves the branch in effect immediately before that request. A mismatched,
  unbound, missing, or otherwise invalid response is classified as
  `CONTEXT_TREE_UPDATE_FAILED`.
- Human success output says `Bound` and shows the repository and final branch.
  JSON success is exactly
  `{"ok":true,"data":{"status":"bound","repo":"<requested repo>","branch":"<final branch>"}}`.
  No success envelope or success status is emitted on a failure.
- An invalid repository exits `2` with `INVALID_CONTEXT_TREE_REPO`; an invalid
  branch exits `2` with `INVALID_CONTEXT_TREE_BRANCH`. Agent-selection failures
  exit `2` with their existing `MISSING_AGENT`, `AMBIGUOUS_AGENT`,
  `ENV_AGENT_NOT_LOCAL`, or `UNKNOWN_AGENT` envelope. These local failures make
  no HTTP request and are not reported as `CONTEXT_TREE_UPDATE_FAILED`.
  Authentication failures exit `3`; connection or timeout failures exit `6`;
  403, other HTTP failures, and invalid responses exit `1`. Only these remote,
  authentication, transport, or response failures use the sanitized
  `CONTEXT_TREE_UPDATE_FAILED` envelope. Error output never includes raw
  response text, tokens, credentials, or unredacted private repository values.
- Debug logs identify the selected agent, request phase, derived organization,
  and final status. Warning logs expose only the sanitized category, exit code,
  and HTTP status. No automatic PUT retry or duplicate settings-version
  increment occurs.
- Loose historical values are visible only through the admin repair surface.
  They never become active agent/runtime bindings, and a repair that omits an
  invalid retained branch cannot partially update the row.

## Expected Result

`PASS`: live boundary evidence proves that only the selected agent's
organization is mutated, branch semantics and exact request bodies are correct,
admin scope is enforced, local and selection validation is network-free, and
all failure classes, output, logging, and raw-repair/active-binding boundaries
match the documented contract.

`FAIL`: a reproducible product defect causes a primary, web-selected, or local
fallback; uses the wrong organization, endpoint, or body; permits an
unauthorized mutation; duplicates a PUT; loses a branch; reports success for a
mismatched response; leaks secrets; or emits the wrong exit class or envelope.

`BLOCKED`: isolated database/worktree, throwaway organization/agent/auth
fixtures, route capture, or controlled fault injection cannot be prepared.
These are environment or data preconditions, not product failures.

`INCONCLUSIVE`: only one selector or organization was observed, request
attribution/body/status evidence is incomplete, or unknown-outcome and
read-back evidence is partial or unstable.

## Evidence

Keep target refs and image digests; a redacted A/B fixture summary and
before/after binding values; exact CLI stdout/stderr and exit codes; sanitized
request traces including the derived organization path, selected-agent header,
body keys, and request count; evidence that the non-admin fixture reached the
settings PUT and received its 403 there; server authorization and
settings-version logs; and read-back values from both organizations. Store
artifacts only in the temporary QA run directory, not the repository. Redact
all tokens, cookies, credentials, private repository details, raw response
bodies, and unrelated response content.
