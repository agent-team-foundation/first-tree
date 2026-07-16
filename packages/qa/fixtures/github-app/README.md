# GitHub App Mock Fixtures

Reusable, non-sensitive assets for exercising the GitHub App surface **without a live GitHub App**.

## Scope

These fixtures cover the App paths that need only the two REST endpoints below plus HMAC signing:

- App boot config (the all-or-nothing block), `install-url`, installation-token minting, and the repository catalog;
- signed webhook ingest: signature verification, record-only installation recording, the not-seen / not-bound gates, and
  delivery-id dedup.

They are the setup half for `cases/cross-surface/github-settings-connection-panel.md`, and they provide the signed-ingest
primitives shared with `cases/cross-surface/github-webhook-routing-regression.md`. They do **not** deliver that case's
end-to-end followed-chat card path: `FIRST_TREE_GITHUB_API_BASE_URL` redirects **all** GitHub REST traffic, but this mock
only answers two endpoints, so a real `follow` (which additionally calls `GET /repos/:owner/:repo` and
`GET /repos/:owner/:repo/issues/:n`), the OAuth paths, and org-repo listing all fall through to `404`. Full card/inbox
delivery needs those extra endpoints mocked plus a following chat — out of scope here.

## Contents

- `mock-github-api.mjs` — a dependency-free stand-in for the two GitHub REST endpoints the server calls
  (`POST /app/installations/:id/access_tokens`, `GET /installation/repositories`). Returns canned data; does not verify the
  app JWT or installation token.
- `webhook-payloads/` — minimal valid bodies: `ping.json`, `installation-created.json`, `issues-opened.json`. The issue
  payload targets the same installation id (`88800002`) the create payload records, so the two compose.

## Enabling the App in the QA run cell

The five core credentials (id, client id/secret, private key, webhook secret) are an atomic block — set them together or
the server rejects the config at boot. `_SLUG` is separate: optional at boot, required only for `install-url` (the recipe
sets it because it exercises that route).

```
FIRST_TREE_GITHUB_APP_ID=123456
FIRST_TREE_GITHUB_APP_CLIENT_ID=Iv1.mockclientid00
FIRST_TREE_GITHUB_APP_CLIENT_SECRET=mock_client_secret_0123456789abcdef
FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET=mock_webhook_secret_topsecret_123
FIRST_TREE_GITHUB_APP_SLUG=mock-first-tree-app          # needed for install-url
FIRST_TREE_GITHUB_API_BASE_URL=http://<mock-host>:9000  # a URL the SERVER can reach — see below
```

`FIRST_TREE_GITHUB_API_BASE_URL` must resolve **from inside the server**. If the mock runs in the same container as the
server, use `http://localhost:9000`; if it runs in a sibling container or on the host, use the compose service name
(`http://mock:9000`) or `http://host.docker.internal:9000` — `localhost` from inside the server container is that
container's own loopback, not the host.

The private key must be a real PEM so app-JWT signing does not crash (the mock does not verify it). Generate a throwaway
key at run time — **do not commit one** (a committed key, even a mock, trips secret scanners):

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/mock-app-key.pem
```

Node (22.13+ here) does accept a quoted multi-line value in `--env-file`, so a quoted PEM in `.env` works. A shell export
is shown here only to sidestep the quoting/escaping fuss:

```bash
export FIRST_TREE_GITHUB_APP_PRIVATE_KEY="$(cat /tmp/mock-app-key.pem)"
```

## Running the mock API

```bash
node mock-github-api.mjs        # listens on 0.0.0.0:9000 (or `node mock-github-api.mjs 9100`, or MOCK_PORT=9100)
```

With the App configured and the mock reachable, `GET /orgs/:org/github-app-installation/repositories` mints a token
against the mock and returns the canned catalog, and `GET .../install-url` returns the `installations/new` URL plus the
`oauth_state_nonce` cookie.

## Signing and posting a webhook

The receiver checks `x-hub-signature-256: sha256=<HMAC-SHA256(webhook_secret, raw_body)>`. Sign the exact bytes you post:

```bash
SECRET=mock_webhook_secret_topsecret_123
sign() { printf 'sha256=%s' "$(openssl dgst -sha256 -hmac "$SECRET" -binary < "$1" | xxd -p -c256 | tr -d '\n')"; }

# Record an installation (unbound). Lifecycle events short-circuit BEFORE the dedup/claim path.
curl -sS -X POST "$BASE/api/v1/webhooks/github-app" \
  -H "content-type: application/json" -H "x-github-event: installation" \
  -H "x-github-delivery: $(uuidgen)" \
  -H "x-hub-signature-256: $(sign webhook-payloads/installation-created.json)" \
  --data-binary @webhook-payloads/installation-created.json
```

Expected: `ping` → `200 {ok}`; a missing/incorrect signature → `401`; `installation-created` → `created:recorded` with a
new **unbound** `github_app_installations` row carrying the sender as installer. `issues-opened` targets that same
installation (`88800002`): posted before the row is bound it is ignored (`installation not bound`); bind the row (connect
it from the Settings panel, or stub it via the dev-callback `installationId` param) and post it again and it normalizes.

### Delivery-id dedup

Dedup lives in `processScmWebhookDelivery`, which only **non-lifecycle** events reach (installation lifecycle events
return before it, so they never claim a delivery id). Demonstrate it with `issues-opened` on the bound installation, and
capture the delivery id **once** so both posts reuse it:

```bash
DELIVERY_ID=$(uuidgen)
SIG=$(sign webhook-payloads/issues-opened.json)
post() { curl -sS -X POST "$BASE/api/v1/webhooks/github-app" \
  -H "content-type: application/json" -H "x-github-event: issues" \
  -H "x-github-delivery: $DELIVERY_ID" -H "x-hub-signature-256: $SIG" \
  --data-binary @webhook-payloads/issues-opened.json; echo; }
post   # first: processed (audience_empty without a following chat)
post   # second, same delivery id: {deduped:true}
```

Keep the webhook secret and generated key out of committed evidence.
