---
id: agent-context-tree-binding-read
description: Validate that the CLI reads only the selected agent organization's Cloud Context Tree binding and fails closed when that binding is unreadable.
areas: [cross-surface]
surfaces: [cli, client, server]
---

# Agent Context Tree Binding Read

## Goal

Confirm that `first-tree org context-tree` reports the Context Tree binding for
the selected local agent's organization, including when that organization is
not the user's primary organization. The read must cross the CLI, SDK, and
agent-scoped server boundary and use the Cloud `context_tree` setting as its
only source of truth. Local workspace state, the web app's selected
organization, and user-default organization state must not influence the
result.

This command crosses CLI, auth/runtime-session, SDK, server scope, and
multi-organization boundaries, so formal QA is warranted before release.
Adding this case does not itself start or record a formal QA run; execute it
only when a human requests formal QA, using the package's isolated run flow.
Deterministic product tests own exact normalization, error mapping, resolution
branches, and output envelopes. This case owns the real scoped HTTP and
credential boundaries those tests cannot prove.

## Preconditions

- Run the target refs in an isolated Docker plus temporary git-worktree cell
  with a live PostgreSQL database, candidate server, and candidate CLI. Do not
  reuse the operator's First Tree home, credentials, workspace, or hosted
  organizations.
- Create a throwaway user who is an ordinary active member, not an organization
  administrator. Give the user a primary organization A and membership in a
  different organization B. Configure local agent `alpha` in A and local agent
  `beta` in B, both managed by that user.
- Give A and B visibly different Cloud Context Tree settings. B's bound value
  should use a repository and branch that cannot be mistaken for A's. Also
  prepare a third throwaway organization/agent whose Cloud setting is unbound;
  if the wire response includes a default `branch: "main"`, retain that setup
  so the CLI's unbound normalization is observable.
- Place a valid but deliberately conflicting Context Tree checkout, workspace
  manifest, and repository metadata under the CLI process's working directory.
  These are misleading local fixtures only; they must not match B's Cloud
  setting.
- Capture outbound HTTP method/path/headers at a redacting proxy or candidate
  server boundary. Never retain JWTs, runtime-session tokens, cookies, or full
  unredacted headers in artifacts.

Fixture creation is allowed only inside the isolated run cell. The QA role must
not mutate a real user's organizations, bindings, agents, or local checkout.

## Operate

- With both `alpha` and `beta` configured locally, run
  `first-tree org context-tree --agent beta` as the ordinary member in human
  and JSON modes. Keep `FIRST_TREE_AGENT_ID` set to alpha for one invocation to
  prove the explicit option wins.
- Run the same read without `--agent` while `FIRST_TREE_AGENT_ID` contains
  beta's UUID. In a separate task-local home containing only beta, run it with
  neither selector to exercise the unique-local-agent fallback.
- Keep the misleading local checkout as the current working directory for all
  successful B reads. Change its branch or manifest between two reads without
  changing Cloud state and confirm the result is stable.
- Select the unbound fixture agent. Exercise both human and JSON output,
  including the server response variant that carries `branch: "main"` with a
  null repository when available.
- In a home with alpha and beta but no selector, exercise the ambiguous-agent
  branch. Also sample an unknown explicit name or a non-local
  `FIRST_TREE_AGENT_ID` if the run-local plan needs evidence that local
  resolution fails before HTTP.
- Exercise unreadable behavior with controlled run-cell faults: an expired or
  rejected member credential for authentication, an unreachable or timed-out
  candidate endpoint for transport, and a controlled invalid/failed response
  at the proxy or candidate server boundary. Do not reinterpret setup failure
  as a product defect.

Do not run `org bind-tree`, `tree init`, or any other binding mutation as
unbound remediation during this read case. In particular, do not use a command
that might target the user's primary organization while validating an agent in
a different organization.

## Observe

- Every successful read sends only
  `GET /api/v1/agent/context-tree/info`, carries beta's `X-Agent-Id`, and uses
  the current member JWT plus current runtime-session token when the runtime
  supplies one. No request reaches `/me`, legacy
  `/api/v1/context-tree/info`, or an organization selected in the web app.
- Explicit beta, environment-selected beta, and unique-local beta all report
  B's exact Cloud repository and branch, never A's values and never the local
  checkout's conflicting values. The ordinary member can perform this
  read-only operation without organization-admin privileges.
- Human output clearly says `Bound`, `Unbound`, or `Unreadable`. A bound result
  includes repository and branch. Unbound guidance tells the user to contact
  an administrator for the selected agent's organization to bind or initialize
  a tree, without directing the user to a potentially primary-organization
  mutation command.
- JSON bound and unbound results contain only the documented `{ok,data}`
  envelope. A null repository always produces
  `{"status":"unbound","repo":null,"branch":null}`, even when the server
  includes `branch: "main"`; a bound null branch becomes `"main"`.
- Ambiguous, unknown, missing, and environment-mismatch selection failures exit
  `2` with their established codes and make no HTTP request.
- Authentication failure reports `Unreadable`, emits
  `CONTEXT_TREE_UNREADABLE` with `status: "unreadable"`, and exits `3`.
  Connection or timeout faults use the same unreadable envelope and exit `6`;
  other remote or invalid-response faults exit `1`. None is presented as
  unbound.
- JSON mode, whether selected by `--json` or `FIRST_TREE_JSON=1`, emits no
  human status lines. Verbose logs identify the selected agent, read start,
  normalized status, or sanitized unreadable category without exposing tokens,
  credentials, or raw response bodies.

## Expected Result

`PASS`: live boundary evidence shows every selector reads the selected agent's
own organization through the agent-scoped endpoint, an ordinary member can read
it, conflicting local/default/web state has no effect, unbound is normalized,
selection fails before HTTP, and all unreadable branches fail closed with the
documented state and exit class.

`FAIL`: a reproducible product defect causes the command to read the primary or
web-selected organization, consult local workspace state, call `/me` or the
legacy endpoint, require administrator privileges, issue HTTP after local
selection failure, leak credentials/response bodies, report a read failure as
unbound, or emit the wrong state/exit class.

`BLOCKED`: isolated multi-organization fixtures, valid ordinary-member auth,
runtime-session delivery, route capture, or controlled fault injection cannot
be prepared. These are environment or data preconditions, not product failures.

`INCONCLUSIVE`: only one organization or selector was observed, request paths
or headers could not be attributed to the candidate CLI, local-state isolation
was not demonstrated, or the unreadable evidence was partial or unstable.

## Evidence

Keep the target refs and image digests; redacted organization, agent, and
Cloud-setting fixture summary; exact CLI stdout/stderr and exit codes; sanitized
HTTP request traces showing method/path and selected agent identity; server logs
showing agent-to-organization resolution; and the conflicting local checkout
state used during the reads. Store artifacts in the temporary QA run directory,
not the repository. Redact all tokens, cookies, credentials, private repository
details, and unrelated response content.
