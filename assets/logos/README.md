# Partner logos

Each entry has a `-light.svg` (black fill, for light-mode README) and a
`-dark.svg` (white fill, for dark-mode README). The README uses `<picture>`
with `prefers-color-scheme` to swap between them.

| Slug | Source | License |
|---|---|---|
| `claude-code` | Simple Icons (`anthropic`) | CC0 |
| `codex` | Bootstrap Icons (`bi:openai` via Iconify) | MIT |
| `cursor` | Simple Icons (`cursor`) | CC0 |
| `gemini` | Simple Icons (`googlegemini`) | CC0 |
| `github` | Simple Icons (`github`) | CC0 |
| `mcp` | Simple Icons (`modelcontextprotocol`) | CC0 |
| `openclaw` | `openclaw/openclaw` repo (`docs/assets/pixel-lobster.svg`) | MIT |

Each pair was generated from the same source SVG with `fill="#000000"` (light
variant) and `fill="#ffffff"` (dark variant). To refresh:

```bash
curl -sL "https://cdn.simpleicons.org/<slug>" -o /tmp/x.svg
sed 's/fill="#[^"]*"/fill="#000000"/' /tmp/x.svg > <name>-light.svg
sed 's/fill="#[^"]*"/fill="#ffffff"/' /tmp/x.svg > <name>-dark.svg
```

## Adding a new partner

1. Find the official mark on Simple Icons (https://simpleicons.org/) when
   possible — CC0 license is cleanest.
2. If not on Simple Icons, use Iconify (https://icon-sets.iconify.design)
   from a permissively-licensed icon pack (Bootstrap Icons / Lucide / Tabler).
3. Generate `<name>-light.svg` and `<name>-dark.svg` per the snippet above.
4. Add a `<td>` to the Works-with `<table>` in the root README.

**Sourcing rule:** never lift logos from another open-source project's README —
their license doesn't transfer to the partner's mark. Always use the partner's
official source or a CC0/MIT mirror like Simple Icons.
