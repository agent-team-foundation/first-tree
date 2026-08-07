---
id: registration-first-run-onboarding
description: Validate that a brand-new user can register, complete admin first-run onboarding, and reach a working first chat, including the machine and runtime gates the journey waits on.
areas: [cross-surface]
surfaces: [server, web, client]
---

# Registration And Admin First-Run Onboarding

## Goal

Confirm that somebody with no First Tree account can arrive, sign up, and finish
the admin first-run journey to a usable workspace:

- registration creates a fresh user, org and human agent, and lands on onboarding;
- the team step confirms the org that sign-in already created, renaming it only
  when the prefilled name is actually edited;
- the connect-computer step blocks until a client reports in with a ready runtime,
  then unblocks;
- the create-agent step binds the agent to that client and waits for it to come
  online before offering to start;
- the kickoff chat is created once and the user lands in the workspace with
  onboarding stamped complete;
- from that workspace, the current Team menu exposes the Team-scoped path for
  using an external agent without taking configuration ownership away from
  Settings.

Deterministic tests own copy, field rendering, per-step readiness logic, and the
kickoff contract itself. This case owns what those tests cannot prove: that the
whole sequence connects for a genuinely new identity, that each gate opens on
real state rather than on a stubbed prop, and that the degraded branches a real
user hits are reachable and honest.

`member-work-mode-onboarding` covers the *invited member* paths; this case is the
first user, who becomes an admin and creates the team.

## Preconditions

- A server stack where the caller can observe the database, since some gates are
  driven by rows the browser cannot write.
- **Registration**: First Tree has no password sign-up. Use a real Google/GitHub
  identity, or the localhost-only `auth/github/dev-callback` stub, which requires
  a non-production `NODE_ENV` plus explicit `FIRST_TREE_DEV_CALLBACK_ENABLED`.
  Never expect this stub on a deployed environment — it must 404 there.
- Each attempt needs an identity that has **never signed in before**. Reusing one
  signs in as the earlier user and silently validates nothing.
- A connected client is required from step 2 onward. Either run a real daemon
  against the stack, or seed the `clients` row it would write.

## Scenario

1. Sign up with a previously unseen identity. Verify a user, an organization and
   a human agent are created, the browser lands on `/onboarding`, and the team
   name is prefilled from the identity.
2. Continue past the team step. The organization and the caller's active `admin`
   membership already exist from sign-in; this screen loads that row rather than
   creating one, and leaving the prefilled name unchanged performs **no write at
   all**. Verify it is that same org, and do not expect a creation here — a
   correct run that accepts the prefilled name would otherwise be failed. Repeat
   with an edited name and verify only the display name changes
   (`PATCH /orgs/:orgId`), leaving org identity and membership untouched.
3. On connect-computer, verify **Continue stays disabled** while no client is
   connected, and that the page offers a bootstrap command plus a paste-able
   agent prompt. This negative half matters: a gate that is open by accident
   would not be visible in a passing happy path.
4. Bring a client online reporting a ready runtime. Verify the step names the
   host, lists the detected coding agent, and enables Continue. If the client's
   heartbeat then goes stale, verify the step honestly regresses to
   "your computer isn't connected" rather than staying green — the server sweeps
   connected clients older than `presenceCleanupSeconds`.
5. Create the first agent. Verify it is bound to that client with the chosen
   runtime and visibility, and that the flow waits for presence rather than
   claiming success. With no daemon actually binding, verify the "taking longer
   than usual" branch appears and offers both **Keep waiting** and
   **I'll finish later**.
6. Bring the agent online. Verify the flow advances on its own to the start-chat
   screen.
7. Start the chat. Verify the browser lands on the workspace at `/?c=<chatId>`,
   the kickoff chat exists exactly once, its first message addresses the new
   agent, and the membership carries `onboarding_completed_at` with
   `onboarding_suppressed_reason='completed'`.
8. Open the current Team menu. Verify **Use your own agent** appears in the
   **Current team** section, **Create team** remains under **Add team**, and no
   manual **Join with invite link** action is offered there. Activate the new
   action and verify it lands on
   `/settings/context#coding-agent-access`, where the Context Tree settings page
   opens the **Coding agent setup** section and owns its setup state. This menu
   check does not replace the
   separate `/invite/:token` join-path contract.

## Evidence

A credible result names the identity used, shows the workspace landing with the
kickoff chat, quotes the membership row's onboarding stamps, and shows the
current Team menu plus the resulting coding-agent access URL. For any gate
claimed to have blocked, show the disabled state, not only the later success.

## Limitations

- Seeding `clients` / `agent_presence` instead of running a daemon proves the
  product's reaction to that state, not the daemon's own registration handshake,
  heartbeat or capability probe. Those belong to client/runtime validation. A
  seeded row must mirror what the real write produces — `runtime_state` is
  `idle` on bind, never a value outside `runtimeStateSchema` — or the journey
  advances through a state no daemon can reach.
- The journey is not idempotent. Every attempt leaves a new user, org, agent and
  chat behind, so run it where accumulating rows is acceptable.

## Optional executable aid

`e2e/` holds a Momentic browser suite that walks steps 1–8 unattended and is
useful for a quick regression pass. It is optional tooling, not a replacement for
this case: it needs an external Momentic account, resolves steps through a hosted
model, and covers only the happy path plus the connect-computer gate. Judgement
about whether the journey is genuinely healthy still lives here.
