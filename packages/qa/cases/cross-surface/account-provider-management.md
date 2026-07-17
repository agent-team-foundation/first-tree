# Account Provider Management

## Purpose

Validate Google and GitHub as equal sign-in providers and verify that connection management preserves the existing First Tree account and resources.

## Preconditions

- Run in an isolated Docker environment and temporary git worktree.
- Configure real Google and GitHub OAuth applications with exact callback URLs.
- Prepare two external accounts per provider and one existing GitHub-only First Tree user.
- Capture browser-visible results, user IDs, organization IDs, membership IDs, and connection API responses without recording OAuth codes or tokens.

## Scenarios

1. Sign in with a new Google account. Verify one user, personal team, admin membership, and human agent are created; repeat sign-in and verify the same user ID is reused.
2. Sign in with a new GitHub account. Verify the created resource shape matches Google and the existing GitHub completion URL still works.
3. Use Google and GitHub accounts that expose the same email. Verify separate First Tree users are created and no email-based merge occurs.
4. From a GitHub-only user's Settings → Account page, connect Google. Verify user, organization, membership, agents, and active First Tree tokens remain unchanged.
5. Attempt to connect a Google or GitHub identity already owned by another user. Verify `identity-conflict`, no identity movement, and no resource changes.
6. Disconnect a provider, select the wrong external account during re-authentication, and verify `identity-mismatch` with no deletion. Repeat with the correct account and verify only the target identity is removed.
7. With only one connected provider, verify Disconnect is disabled in the UI and the server rejects a direct unlink-start request with `last-provider`.
8. Start a link or unlink flow, let state expire, and verify a recoverable error returns to Settings → Account without changing the current First Tree session.

## Evidence

- Screenshots of Login, Invite Accept, Settings → Account sign-in methods, disabled last-provider state, and recoverable errors.
- Redacted API responses from `/me`, `/me/auth-providers`, link start, and unlink start.
- Database evidence limited to stable First Tree resource IDs and provider names; never capture raw provider subjects, codes, ID tokens, access tokens, or refresh tokens.

## Result Rules

- `PASS` requires all identity ownership and resource-preservation checks to hold.
- Provider configuration, consent-screen, callback URL, or external-account access failures are `BLOCKED`.
- Any email-based merge, identity movement, last-provider deletion, token replacement during link/unlink, or resource recreation is `FAIL`.
