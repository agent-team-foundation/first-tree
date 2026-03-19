---
title: Agent Context Filtering
owners: []
---

# Agent Context Filtering

## What enters the agent's context

| Source | Data | Sensitive? |
|---|---|---|
| User messages | Chat input | Yes — may contain personal/business info |
| Project files | Parsed document content, images | Yes — user documents |
| User memory | Persistent facts, preferences | Yes — personal knowledge |
| Browser page content | Accessibility tree, page text | Yes — whatever user is browsing |
| Desktop command output | Shell stdout/stderr | Yes — may contain secrets in output |
| Sandbox command output | Shell stdout/stderr | Yes — credentials in env vars |
| Web fetch/search results | Webpage content, search results | Yes — may contain injected instructions |
| Conversation history | All prior messages in session | Yes — full session context |

## What is NOT in the agent's context

Credentials are injected into the sandbox as environment variables and files — they are **not** included in the agent's LLM context. This is a deliberate separation: the agent can instruct the sandbox to use credentials (e.g., `git push`), but the credential values themselves don't appear in the LLM's token stream.

System-level secrets (`INTERNAL_API_KEY`, `JWT_SECRET_KEY`, `DATABASE_URL`, etc.) are never in the agent's context or the sandbox.

## Output filtering

`output_filter.py` redacts credential-like patterns from command output before it enters the agent's context:
- Private key blocks (PEM format)
- AWS access keys (`AKIA` prefix)
- API keys (`sk-` Stripe/OpenAI, `sk_live_`, `sk_test_`)
- JWT tokens
- Passwords in URLs (`://user:password@host`)
- Generic key=value secrets (`password=`, `token=`, `secret=`, `api_key=`)

### Current coverage

| Source | Filtered? | Status |
|---|---|---|
| Desktop command output | Yes | Implemented |
| Sandbox command output | Yes | Implemented (S15) |
| Browser page content | No | Planned |
| File reads | No | Planned |
| Web fetch results | No | Planned |

### Planned improvement

Apply the same redaction patterns to all sources at the agent runtime layer, where all tool results pass through before being added to context. This creates a single chokepoint regardless of which tool produced the output.
