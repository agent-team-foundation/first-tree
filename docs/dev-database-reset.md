# Dev Database Reset

## Full reset (delete container + data)

```bash
docker compose down -v
docker compose up -d
sleep 3
export PATH="/opt/homebrew/bin:$PATH"
DATABASE_URL="postgresql://firsttree:firsttree@localhost:5432/firsttree" \
  pnpm --filter @first-tree/server db:migrate
```

## Users only (keep other data)

```bash
psql postgresql://firsttree:firsttree@localhost:5432/firsttree \
  -c "TRUNCATE auth_identities, users CASCADE;"
```

After either method, restart the server and use an incognito window to re-login.
