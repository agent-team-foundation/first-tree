# Local GitHub App Setup

Use this guide only when local development needs real GitHub integration. Basic
server, web, CLI, and database work can use the dev callback described in
[../../DEVELOPMENT.md](../../DEVELOPMENT.md) instead.

## When This Is Required

Configure a real GitHub App when you need to test any of these flows:

- GitHub OAuth sign-in through github.com.
- GitHub App installation and re-authorization.
- GitHub webhook ingestion.
- Installation-token flows.
- Repository picker behavior backed by GitHub access.
- One-click Context Tree initialization.

## Required Server Environment

Set these in the root `.env` used by `pnpm --filter @first-tree/server dev`:

```dotenv
# Stable identity for the local API and its browser storage namespaces. Keep
# this fixed when the public tunnel below rotates.
FIRST_TREE_SERVER_AUTHORITY=http://127.0.0.1:8000/api/v1
FIRST_TREE_PUBLIC_URL=https://your-public-tunnel.example

FIRST_TREE_GITHUB_APP_ID=123456
FIRST_TREE_GITHUB_APP_CLIENT_ID=Iv1.example
FIRST_TREE_GITHUB_APP_CLIENT_SECRET=github_app_client_secret
FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET=local_webhook_secret
FIRST_TREE_GITHUB_APP_SLUG=your-app-slug
FIRST_TREE_GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----"
```

The five core GitHub App values must be set together or omitted together:

- `FIRST_TREE_GITHUB_APP_ID`
- `FIRST_TREE_GITHUB_APP_CLIENT_ID`
- `FIRST_TREE_GITHUB_APP_CLIENT_SECRET`
- `FIRST_TREE_GITHUB_APP_PRIVATE_KEY`
- `FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET`

`FIRST_TREE_GITHUB_APP_SLUG` is also needed for the Settings -> GitHub
"Install on GitHub" URL. Without it, GitHub sign-in and webhook verification
can still be configured, but the install URL endpoint returns 503.

`FIRST_TREE_PUBLIC_URL` must be the public HTTPS URL that GitHub can call. For
local development, that is normally your tunnel URL, not `http://127.0.0.1:8000`.
It is a callback/return origin, not the persistent server identity;
`FIRST_TREE_SERVER_AUTHORITY` may therefore remain stable while the tunnel
rotates.

## Private Key Formatting

`FIRST_TREE_GITHUB_APP_PRIVATE_KEY` must be the full PKCS#8 PEM value with real
newlines and the `-----BEGIN PRIVATE KEY-----` header. Do not paste literal
`\n` sequences into the value. If your shell or env loader cannot handle a
multiline value, source the variable from a local secret file or shell export
before starting the server.

Never commit a real private key, client secret, webhook secret, PAT, or tunnel
URL.

## Optional Local-Only Environment

These variables are useful in local and test-only flows:

| Variable | Use |
|---|---|
| `FIRST_TREE_DEV_CALLBACK_ENABLED` | Enables `/api/v1/auth/github/dev-callback`. The server dev script already sets this to `1`; never set it in production. |
| `DEV_GITHUB_PAT` | Injects a local PAT into the dev-callback identity so the repo picker can call the real GitHub API without OAuth. Never set it in production. |
| `FIRST_TREE_GITHUB_API_BASE_URL` | Overrides `https://api.github.com` for mocks or advanced tests. Do not set it for normal local GitHub App work. |

## Tunnel Setup

GitHub must reach your local server for OAuth callbacks and webhooks:

1. Start the server on `http://127.0.0.1:8000`.
2. Start your tunnel with the target `http://127.0.0.1:8000`.
3. Set `FIRST_TREE_PUBLIC_URL` to the tunnel's public HTTPS origin, without a
   trailing slash.

Example shape:

```dotenv
FIRST_TREE_PUBLIC_URL=https://example-tunnel.ngrok-free.app
```

## GitHub App Settings

Create or update a GitHub App in GitHub, then set:

- Homepage URL: `${FIRST_TREE_PUBLIC_URL}`
- Callback URL: `${FIRST_TREE_PUBLIC_URL}/api/v1/auth/github/callback`
- Webhook URL: `${FIRST_TREE_PUBLIC_URL}/api/v1/webhooks/github-app`
- Webhook secret: the same value as `FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET`
- Enable "Request user authorization (OAuth) during installation".

Permissions and events are declared in the GitHub App settings page. The install
and authorize URLs do not carry these values. See the GitHub App design in the
First Tree context tree (`system/cloud/github/github-app.md`) for the design
contract.

### Permissions

Repository permissions:

- Administration: Read and write
- Contents: Read and write
- Workflows: Read and write
- Pull requests: Read and write
- Issues: Read-only
- Metadata: Read-only

Organization permissions:

- Members: Read-only

Existing installations must re-approve permission upgrades in GitHub before
flows such as one-click Context Tree initialization can rely on the new grant.

### Subscribed Events

Subscribe the GitHub App to:

- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review`
- `push`
- `installation`
- `installation_repositories`
- `member`

The server also accepts GitHub's `ping` event on the same webhook endpoint.

## Verification

After updating `.env` and GitHub App settings:

1. Restart the server:

   ```bash
   pnpm --filter @first-tree/server dev
   ```

2. Check liveness:

   ```bash
   curl http://127.0.0.1:8000/healthz
   ```

3. Open the web app at `http://127.0.0.1:5173`.
4. Sign in with GitHub.
5. Go to Settings -> GitHub -> Install on GitHub.
6. Complete the GitHub installation flow.
7. Confirm the installation row appears in the Settings -> GitHub UI.

If webhook delivery fails, inspect the GitHub App's webhook delivery log in
GitHub. Confirm the delivery URL, status code, and signature secret before
debugging server-side behavior.

## Common Failures

| Symptom | Likely cause | Fix |
|---|---|---|
| 503 from `/api/v1/auth/github/start` | GitHub App env block is missing or incomplete. | Set all five core `FIRST_TREE_GITHUB_APP_*` values, then restart the server. |
| 503 from the install URL endpoint | `FIRST_TREE_GITHUB_APP_SLUG` is missing. | Set the App slug from `https://github.com/apps/<slug>`, then restart the server. |
| Callback or state failure after GitHub redirects back | The install URL was stale, the state expired, or `FIRST_TREE_PUBLIC_URL` no longer matches the active tunnel. | Restart the flow from the local web UI and confirm the GitHub App callback URL uses the current tunnel. |
| 501 from `/api/v1/webhooks/github-app` | Webhook secret or GitHub App config is not loaded. | Set the core GitHub App env values and restart the server. |
| Webhook signature failure | GitHub and First Tree are using different webhook secrets. | Copy the GitHub App webhook secret into `FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET`, then redeliver the webhook. |
| Context Tree initializer permission failure | The App permissions were not approved, or an existing installation has not re-approved a new permission request. | Re-approve the installation in GitHub and confirm Administration, Contents, Workflows, and Pull requests are write-enabled. |
