# Cursor CLI Phase 0 — non-zero-exit / no-result fixtures

Settle boundary = **process close**, not the `result` event. When exit code != 0 and no
`result` event was emitted, classify from stderr.

## 4a. Logged out → AuthError (NOT retryable; user action)
- exit code: `1`
- stdout: empty (no JSON at all)
- stderr:
```
Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.
```
- classify regex: `/Authentication required|CURSOR_API_KEY/i`

## 4b. Invalid model → ConfigError (NOT retryable; bad --model)
- exit code: `1`
- stdout: empty (no JSON)
- stderr (head): `Cannot use this model: <id>. Available models: auto, gpt-5.3-codex-low, ... , glm-5.2-high, glm-5.2-max`
- classify regex: `/Cannot use this model:/i`
- note: stderr contains the full live model list; could be a fallback discovery source, but primary discovery is `agent models`.

## 4c. Usage / quota limit → ActionRequired (NOT retryable; account state)
- exit code: `1`
- stdout: only `system:init` + `user`, then process exits — NO assistant / tool_call / result:
```jsonl
{"type":"system","subtype":"init","apiKeySource":"env","cwd":"/private/tmp/cursor-cli-resume-3qSQXm","session_id":"19b60fd8-1bb7-4b8a-acb2-3210997369a4","model":"Codex 5.3 High","permissionMode":"default"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Without tools, reply exactly FT_CROSS_FAMILY_SWITCH_OK followed by one space and the nonce from the first turn."}]},"session_id":"19b60fd8-1bb7-4b8a-acb2-3210997369a4"}
```
- stderr:
```
ActionRequiredError: You've hit your usage limit You've saved $48 on API model usage this month with Pro. Switch to a different model or set a Spend Limit to continue with this model. Your usage limits will reset when your monthly cycle ends on 7/30/2026.
```
- classify regex: `/ActionRequiredError|usage limit/i`
- note: resume + model switch (Codex 5.3 High) were ACCEPTED (same session_id); failure was purely account quota, not a session-model rejection.

## Implementation notes (from yzw-codex)
- **Version probe:** `agent --version` → stdout `2026.07.09-a3815c0\n` (trim). Single line, no prefix.
- **Resolver:** `agent` and `cursor-agent` both symlink the same binary; prefer `agent`, fall back `cursor-agent`.
- **Model switch:** no account-available model produced a session-compatibility rejection; composer-2.5 → composer-2.5-fast kept the same session_id. Don't assume a new session is required on model switch — pass `--model`, and surface Cursor's exact error if it ever rejects.
- **apiKeySource:** observed value `"env"` (CURSOR_API_KEY set). Auth *failure* emits no JSON (exits before init) → classify auth from stderr, not from an `apiKeySource=none` event.
- **Smoke gate:** independent CLI currently logged out; zero-key E2E needs operator `agent login` first (that's on yuezengwu; yzw-codex will run the smoke against pushed `feat/cursor-cli-provider`).
