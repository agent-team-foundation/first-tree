# Supply — fill in a missing detail the agent cannot derive

A request-style NHA used when the agent has all the pieces of a task except one **factual** input that only a human can resolve — credentials, a numerical threshold, an account id, a policy interpretation. Demonstrates a tiny option set with an opt-in free-text path.

## CLI

```bash
first-tree attention raise \
  --chat infra-onboarding \
  --target yuezengwu \
  --subject "Need a prod Sentry DSN to wire alerts on the new service" \
  --body @body.md \
  --requires-response \
  --meta 'tags[0]=supply' \
  --meta 'tags[1]=credentials' \
  --meta-json @options.json
```

## body.md

```markdown
## Question
The new `orders-checkout` service is ready to send to Sentry, but I don't have a DSN for the prod project. Please give me one, or tell me which existing project to reuse.

## Background
- Staging verified, scheduled to ship tonight
- Existing Sentry projects I can see: `web-frontend`, `api-gateway`, `worker`
- I don't know which project prod traffic should land in — I'd rather not invent a new project name on my own

## What I'll do
- You reply "reuse-gateway": route all alerts under api-gateway
- You reply "new-project": I create `orders-checkout` in the Sentry web UI, then come back to wire the DSN
- You paste a DSN directly: I use it as-is for the ship

## Validity scope
This deploy of `orders-checkout` only. I'll ask again for any future new service.
```

## options.json

```json
{
  "options": {
    "mode": "single",
    "items": [
      { "value": "reuse-gateway", "label": "Reuse the api-gateway project" },
      { "value": "new-project",   "label": "Create a new orders-checkout project" },
      {
        "value": "paste-dsn",
        "label": "Paste a DSN directly (write it in the free-form reply)",
        "input": { "type": "text", "placeholder": "https://...@sentry.io/..." }
      }
    ]
  },
  "fallback": "block deploy, ping #infra",
  "validityScope": "this service deploy only"
}
```

## Notes

- "Supply" is for **missing facts**, not for **decision authorization**. If you can supply it yourself (read the tree, README, a read-only command), don't raise an NHA.
- Input-typed options (`input.type=text/number/datetime`) signal the UI to render an input under that option; today the web simplifies this to "tick this option → switch to free-form mode", which matches the mockup behavior.
- Each Supply NHA asks for **one** factual point. For 3 related parameters (DSN + release token + env name all missing), use `metadata.questions[]` instead (see `multi-question-launch.md`).
- Don't dump the answer into a generic `notes` field — capture it in structured `answers` so future-you can grep it.
