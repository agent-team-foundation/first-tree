# Partner logos

All partner logos use **original brand colors** (paperclip-style). For brands
with monochrome marks (Cursor / GitHub / MCP), the `-light.svg` keeps the
brand black/dark color and the `-dark.svg` is a white-fill variant so the
mark stays visible against GitHub's dark theme. Brands with saturated brand
colors (Claude orange, Codex green, Gemini purple) use the same fill in
both variants.

| Slug           | Source                                                                    | Brand color (light → dark)   | License             |
| -------------- | ------------------------------------------------------------------------- | ---------------------------- | ------------------- |
| `claude-code`  | Bootstrap Icons `bi:claude` via Iconify — Claude mark, not Anthropic logo | `#D97757` (Anthropic orange) | MIT                 |
| `codex`        | Bootstrap Icons `bi:openai` via Iconify                                   | `#10A37F` (OpenAI green)     | MIT                 |
| `cursor`       | Simple Icons (`cursor`)                                                   | `#000000` → `#ffffff`        | CC0                 |
| `gemini`       | Simple Icons (`googlegemini`)                                             | `#8E75B2` (Gemini purple)    | CC0                 |
| `github`       | Simple Icons (`github`)                                                   | `#181717` → `#ffffff`        | CC0                 |
| `mcp`          | Simple Icons (`modelcontextprotocol`)                                     | `#000000` → `#ffffff`        | CC0                 |
| `openclaw.png` | `https://avatars.githubusercontent.com/openclaw` (org avatar)             | full-color red lobster       | OpenClaw brand mark |

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
