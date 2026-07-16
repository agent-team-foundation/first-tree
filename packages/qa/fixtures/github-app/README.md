# GitHub App Mock Fixtures

Reusable, non-sensitive assets for exercising the GitHub App surface (install-url, installation-token minting,
repository catalog, and signed webhook ingest) **without a live GitHub App**. Use these with
`cases/cross-surface/github-settings-connection-panel.md` and `cases/cross-surface/github-webhook-routing-regression.md`.

## Contents

- `mock-github-api.mjs` — a dependency-free stand-in for the two GitHub REST endpoints the server calls
  (`POST /app/installations/:id/access_tokens`, `GET /installation/repositories`). It returns canned data and does not
  verify the app JWT or installation token.
- `webhook-payloads/` — minimal valid bodies: `ping.json`, `installation-created.json`, `issues-opened.json`.

## Enabling the App in the QA run cell

The server's App config block is all-or-nothing — set every field together or the server rejects it at boot:

```
FIRST_TREE_GITHUB_APP_ID=123456
FIRST_TREE_GITHUB_APP_CLIENT_ID=Iv1.mockclientid00
FIRST_TREE_GITHUB_APP_CLIENT_SECRET=mock_client_secret_0123456789abcdef
FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET=mock_webhook_secret_topsecret_123
FIRST_TREE_GITHUB_APP_SLUG=mock-first-tree-app          # needed for install-url
FIRST_TREE_GITHUB_API_BASE_URL=http://localhost:9000    # redirect REST calls to the mock
```

The private key must be a real PEM so app-JWT signing does not crash (the mock does not verify it). Generate a throwaway
key at run time — **do not commit one** (a committed key, even a mock, trips secret scanners):

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/mock-app-key.pem
```

`node --env-file` cannot hold a multi-line PEM, so pass the key via a shell export rather than the `.env` file:

```bash
export FIRST_TREE_GITHUB_APP_PRIVATE_KEY="$(cat /tmp/mock-app-key.pem)"
```

## Running the mock API

```bash
node mock-github-api.mjs        # listens on :9000 (or `node mock-github-api.mjs 9100`, or MOCK_PORT=9100)
```

With the App configured and the mock reachable, `GET /orgs/:org/github-app-installation/repositories` mints a token
against the mock and returns the canned catalog, and `GET .../install-url` returns the `installations/new` URL plus the
`oauth_state_nonce` cookie.

## Signing a webhook

The receiver checks `x-hub-signature-256: sha256=<HMAC-SHA256(webhook_secret, raw_body)>`. Sign a payload and post it:

```bash
SECRET=mock_webhook_secret_topsecret_123
BODY=webhook-payloads/installation-created.json
SIG="sha256=$(openssl dgst -sha256 -hmac "$SECRET" -binary < "$BODY" | xxd -p -c256 | tr -d '\n')"
curl -sS -X POST "$BASE/api/v1/webhooks/github-app" \
  -H "content-type: application/json" \
  -H "x-github-event: installation" \
  -H "x-github-delivery: $(uuidgen)" \
  -H "x-hub-signature-256: $SIG" \
  --data-binary @"$BODY"
```

Expected shapes: `ping` → `200 {ok}`; a missing/incorrect signature → `401`; `installation-created` →
`created:recorded` with a new **unbound** `github_app_installations` row carrying the sender as installer;
`issues-opened` on an unbound installation → ignored, on a bound installation → normalized (delivering a card needs a
following chat — see the webhook-routing case). Re-posting the same `x-github-delivery` returns `{deduped:true}`.

Keep the webhook secret and generated key out of committed evidence.
