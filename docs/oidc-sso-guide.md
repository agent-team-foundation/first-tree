# OIDC SSO for Private Deployments

This guide covers configuring OpenID Connect (OIDC) single sign-on for
enterprise private deployments of First Tree.

## Prerequisites

- A First Tree Server deployment (Docker image or source)
- An OIDC-capable Identity Provider (GitLab, Keycloak, Okta, Azure AD, etc.)
- Admin access to register an OAuth/OIDC application on the IdP

## IdP Application Registration

Register a new application on your Identity Provider with:

| Field | Value |
|-------|-------|
| Name | `First Tree` (or any label) |
| Redirect URI | `<FIRST_TREE_PUBLIC_URL>/api/v1/auth/oidc/callback` |
| Confidential | Yes |
| Scopes | `openid`, `profile`, `email` |

Example for a deployment at `https://first-tree.example.com`:
```
Redirect URI: https://first-tree.example.com/api/v1/auth/oidc/callback
```

Record the **Client ID** and **Client Secret** provided by the IdP.

## Environment Variables

Add these to your deployment environment (`.env`, Docker Compose, systemd, etc.):

```bash
# Required: set the auth mode
FIRST_TREE_AUTH_MODE=oidc-required

# Required: OIDC provider configuration
FIRST_TREE_OIDC_ISSUER=https://your-idp.example.com
FIRST_TREE_OIDC_CLIENT_ID=<application-id>
FIRST_TREE_OIDC_CLIENT_SECRET=<application-secret>
```

### Configuration Rules

| Scenario | Behavior |
|----------|----------|
| `AUTH_MODE` missing or empty | Defaults to `standard` (current Google/GitHub) |
| `AUTH_MODE=oidc-required` without OIDC vars | Server refuses to start |
| Partial OIDC vars (e.g. issuer without secret) | Server refuses to start |
| Complete OIDC vars with `AUTH_MODE=standard` | OIDC remains dormant; no network I/O |
| `OIDC_ISSUER` is HTTP in production | Server refuses to start |

### Issuer Requirements

- Must be a valid HTTPS URL in production
- Must have no path, query, or fragment components
- Must exactly match the `issuer` field in the IdP's `/.well-known/openid-configuration`
- Changing the issuer is an unsupported identity migration

## Callback URL

The callback URL is derived automatically:
```
<FIRST_TREE_PUBLIC_URL>/api/v1/auth/oidc/callback
```

Ensure `FIRST_TREE_PUBLIC_URL` is set to the externally reachable URL of your
First Tree server.

## How It Works

1. User clicks "Continue with SSO" on the login page
2. Browser redirects to IdP authorization endpoint (with PKCE S256)
3. User authenticates at the IdP
4. IdP redirects back to First Tree callback with an authorization code
5. Server exchanges the code for tokens, verifies the id_token signature via JWKS
6. User identity is mapped as `(issuer, sub)` in `auth_identities`
7. First Tree JWT is issued and the user enters the application

## Identity Mapping

Each OIDC user is identified by the tuple `(issuer, sub)`. This means:
- The same IdP user always maps to the same First Tree account
- Different IdP users never collide
- Changing the issuer creates new, unlinked identities

## Known Limitations (V1)

Document these for your operations team:

- **No IdP-initiated logout.** Disabling a user in the IdP does not immediately
  revoke their First Tree session. Existing tokens continue until expiry.
- **No automatic revocation.** To immediately block access, set the local user
  status to suspended via the database.
- **Refresh tokens slide.** An active client that keeps refreshing can maintain
  access indefinitely. Lower `FIRST_TREE_AUTH_REFRESH_TOKEN_EXPIRY` to bound
  the window.
- **Mode switch does not migrate accounts.** Switching from `standard` to
  `oidc-required` on a populated deployment does not link existing accounts.
- **Single issuer.** Only one OIDC issuer per deployment is supported.

## Troubleshooting

### "OIDC discovery failed"
Server cannot reach `<issuer>/.well-known/openid-configuration`. Check network
connectivity from the server to the IdP.

### "OIDC issuer mismatch"
The `issuer` field in the discovery document does not match
`FIRST_TREE_OIDC_ISSUER`. Ensure the value is exact (no trailing slash
differences).

### "The redirect URI included is not valid" (at IdP)
The `redirect_uri` sent by the server does not match what's registered in the
IdP application. Verify `FIRST_TREE_PUBLIC_URL` and the registered redirect URI
are identical.

### "state-expired" after callback
The browser cookie was lost between `/start` and `/callback`. Common causes:
- Too much time elapsed (>10 minutes)
- Browser cookie settings blocking HttpOnly cookies
- Proxy stripping `Set-Cookie` headers
