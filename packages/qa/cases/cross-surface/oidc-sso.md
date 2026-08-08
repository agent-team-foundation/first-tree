# QA Case: OIDC SSO Authentication

## Surface
Server + Web (cross-surface)

## Risk Tier
High — authentication path, identity creation, session issuance

## Prerequisites
- Server running with `FIRST_TREE_AUTH_MODE=oidc-required` and valid OIDC config
- An OIDC IdP reachable from the server (e.g. GitLab, Keycloak)
- A test user account on the IdP

## Scenarios

### 1. Fresh OIDC sign-in (happy path)
1. Open the login page
2. Verify only "Continue with SSO" button is visible (no Google/GitHub)
3. Click "Continue with SSO"
4. Verify redirect to IdP authorization page
5. Authorize on the IdP
6. Verify redirect back to First Tree and successful login
7. Verify onboarding starts (new user) or dashboard loads (returning user)

### 2. Returning OIDC user
1. Sign out
2. Click "Continue with SSO" again
3. Verify the same First Tree account is reused (no duplicate)

### 3. Bootstrap config in oidc-required mode
1. GET `/api/v1/bootstrap/config`
2. Verify `authMode` is `"oidc-required"`
3. Verify `authProviders.oidc` is `true`
4. Verify `authProviders.google` and `authProviders.github` are `false`

### 4. OIDC routes return 404 in standard mode
1. Set `FIRST_TREE_AUTH_MODE=standard` (or unset), restart server
2. GET `/api/v1/auth/oidc/start`
3. Verify 404 response

### 5. Boot validation rejects partial config
1. Set `FIRST_TREE_AUTH_MODE=oidc-required` but omit `FIRST_TREE_OIDC_CLIENT_SECRET`
2. Attempt to start the server
3. Verify server refuses to boot with an actionable error message

### 6. GitHub remains available as capability connection
1. In oidc-required mode, after OIDC login
2. Navigate to Team Settings → GitHub
3. Verify GitHub App install flow still works (repo access, not sign-in)
