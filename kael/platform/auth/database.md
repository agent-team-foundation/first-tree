---
title: Database Access & Credentials
owners: []
---

# Database Access & Credentials

## Connection Architecture

Two PostgreSQL databases:
- **Business database** (`DB_URL`) — sessions, projects, files, credentials, tokens, memory, credits
- **Vector database** (`VECTOR_DB_URL`) — embeddings and vector search via pgvector (falls back to business DB if not configured)

Both accessed via SQLAlchemy async engine with connection pooling (pool size 10, max overflow 20, pool pre-ping enabled).

## Database Credentials

Currently a single PostgreSQL role is used for all operations. No role separation between read/write, admin, or per-service access.

| Consumer | Credential | Access Level |
|---|---|---|
| kael-backend | `DB_URL` | Full read/write on all tables |
| kael-logger | `DATABASE_URL` | Direct access to BetterAuth tables (user, session) |
| Migrations | Same `DB_URL` | Schema changes run through same role |

## Encrypted Fields

Fernet encryption (`OAUTH_ENCRYPTION_KEY`) protects third-party credentials:
- `external_credentials.access_token_encrypted` — OAuth access tokens / API keys
- `external_credentials.refresh_token_encrypted` — OAuth refresh tokens
- `feishu_bot_registrations.app_secret_encrypted` — Feishu app secret
- `feishu_bot_registrations.encrypt_key_encrypted` — Feishu event encryption key

## Unencrypted Sensitive Data

- Conversation history (`sessions.all_messages` JSON)
- User memory entries (`memory_entries.content`)
- Project names and descriptions
- User IDs across all tables

## Multi-Tenant Isolation

No PostgreSQL Row-Level Security (RLS). User isolation relies entirely on application-level `WHERE user_id = ?` filtering in repository queries.
