# Google OAuth operator setup

First Tree uses the Google OpenID Connect Authorization Code flow for sign-in
and authentication-provider management. It requests only identity data and
does not request Google API access or persist Google access or refresh tokens.

## Google Cloud configuration

1. In Google Cloud Console, configure the OAuth consent screen for the
   deployment.
2. Create an OAuth 2.0 Client ID with application type **Web application**.
3. Add this exact Authorized redirect URI:

   ```text
   ${FIRST_TREE_PUBLIC_URL}/api/v1/auth/google/callback
   ```

   For example, when `FIRST_TREE_PUBLIC_URL=https://app.first-tree.ai`, use:

   ```text
   https://app.first-tree.ai/api/v1/auth/google/callback
   ```

Google requires the redirect URI sent during authorization and token exchange
to exactly match a registered URI. Match the scheme, host, port, path, and
trailing-slash form; do not add a trailing slash to the callback shown above.

## Server configuration

Set the public origin and both Google credentials in the server environment:

```bash
FIRST_TREE_PUBLIC_URL=https://app.first-tree.ai
FIRST_TREE_GOOGLE_CLIENT_ID=example.apps.googleusercontent.com
FIRST_TREE_GOOGLE_CLIENT_SECRET=replace-with-secret-manager-reference
```

`FIRST_TREE_GOOGLE_CLIENT_ID` and `FIRST_TREE_GOOGLE_CLIENT_SECRET` form one
optional configuration block. Set both to enable Google, or omit both to keep
it disabled. Supplying only one causes configuration validation to fail at
startup.

The authorization request always uses these scopes:

```text
openid email profile
```

Do not add Google API scopes unless the product contract and token-storage
model are deliberately changed and reviewed.

## Verification

1. Restart the server after changing the environment.
2. Request `GET /api/v1/bootstrap/config` and confirm
   `authProviders.google` is `true`.
3. Open the login page and confirm the Google action is visible.
4. Complete a new Google sign-in and confirm the callback returns to
   `/auth/complete` rather than a Google `redirect_uri_mismatch` error.
5. Open `/user-settings` and confirm the Google connection snapshot is shown.

If `authProviders.google` remains `false`, verify that both environment
variables reached the server process. If Google reports a redirect mismatch,
compare the registered URI with `FIRST_TREE_PUBLIC_URL` and the callback path
character for character.
