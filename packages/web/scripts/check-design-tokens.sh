#!/usr/bin/env bash
# Design-token guardrails for packages/web/src.
#
# Enforces the hard constraints from the Typography-unification refactor:
#   - no raw pixel literals (use --sp-* or Tailwind spacing utilities)
#   - no hardcoded hex / rgb / rgba colors (use semantic CSS tokens)
#   - no Tailwind default palette classes (use semantic tokens)
#   - no disallowed font-weight values — only 400 / 500 / 600 / 700
#   - no raw inline font sizing / weighting (use text-* tokens)
#
# index.css is the single source of truth and is exempt from every scan.
# Fails on first violation; re-run after each fix batch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$WEB_ROOT/src"

fail=0
report() {
  echo ""
  echo "❌ $1"
  echo "$2"
  fail=1
}

# 1. Raw px literals — tokenize via --sp-* (or --hairline/--hairline-bold).
hits=$(grep -rnE '[0-9]+(\.[0-9]+)?px' \
  --include="*.tsx" --include="*.ts" \
  "$SRC" || true)
if [ -n "$hits" ]; then
  report "Raw \`Npx\` literals found (use --sp-* / --hairline tokens or Tailwind spacing utilities):" "$hits"
fi

# 2. Hex / rgb / rgba literals — tokenize via --color-* or oklch().
hits=$(grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(' \
  --include="*.tsx" --include="*.ts" \
  "$SRC" || true)
if [ -n "$hits" ]; then
  report "Hardcoded hex / rgb / rgba colors found (use --color-* tokens):" "$hits"
fi

# 3. Tailwind default palette classes — use semantic tokens (success/warn/error,
#    fg-*, bg-*, border-*, state-*).
hits=$(grep -rnE '\b(text|bg|border|decoration|ring|fill|stroke|from|to|via)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(-[0-9]{2,3}|/[0-9]+)?\b' \
  --include="*.tsx" \
  "$SRC" || true)
if [ -n "$hits" ]; then
  report "Tailwind default palette class found (use semantic color tokens):" "$hits"
fi

# 4. Disallowed font-weight values (outside 400/500/600/700).
hits=$(grep -rnE '\bfont-(thin|extralight|light|extrabold|black)\b|fontWeight:\s*(100|200|300|800|900)' \
  --include="*.tsx" \
  "$SRC" || true)
if [ -n "$hits" ]; then
  report "Disallowed font-weight (only 400/500/600/700 allowed — see index.css @theme):" "$hits"
fi

# 5. Inline font sizing / weighting / family / line-height / letter-spacing.
#    All typography should come from text-* tokens in index.css.
hits=$(grep -rnE 'style=\{[^}]*\b(fontSize|fontWeight|fontFamily|lineHeight|letterSpacing):' \
  --include="*.tsx" \
  "$SRC" || true)
if [ -n "$hits" ]; then
  report "Inline font property found (use text-eyebrow/caption/label/body/subtitle/title + font-medium/semibold/bold classes):" "$hits"
fi

# 6. Tailwind v3 default text-size classes — all uses should go through the
#    semantic scale (eyebrow/caption/label/body/subtitle/title).
hits=$(grep -rnE '\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b' \
  --include="*.tsx" \
  "$SRC" || true)
if [ -n "$hits" ]; then
  report "Tailwind default text-size class found (use text-eyebrow/caption/label/body/subtitle/title):" "$hits"
fi

# 7. Undefined token references — every literal `var(--x)` must resolve to a
#    token defined in index.css (the source of truth) or set inline in a
#    component style object (e.g. `"--foo": value`). Catches ghost tokens like
#    `var(--surface-1)` that silently fail at runtime. Dynamic refs such as
#    `var(--state-${x})` are skipped: the closing-paren match never matches them.
defined_file=$(mktemp)
{
  # tokens declared in index.css (:root / .dark / @theme / .landing-marketing)
  grep -hoE -e '--[a-zA-Z0-9_-]+[[:space:]]*:' "$SRC/index.css" 2>/dev/null || true
  # tokens set inline in components, e.g. style={{ "--foo": value }} or the
  # computed-key form `["--foo" as string]: value` — match any quoted token
  # literal in source so inline custom properties count as defined.
  grep -rhoE --include="*.tsx" --include="*.ts" -e '"--[a-zA-Z0-9_-]+"' "$SRC" 2>/dev/null || true
} | sed -E 's/"//g; s/[[:space:]]*:$//' | sort -u > "$defined_file"

undef=""
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  grep -qxF -e "$ref" "$defined_file" || undef="${undef}
  ${ref}"
done < <(grep -rhoE --include="*.tsx" --include="*.ts" --include="*.css" --exclude-dir=__tests__ \
  -e 'var\(--[a-zA-Z0-9_-]+\)' "$SRC" 2>/dev/null | sed -E 's/^var\(//; s/\)$//' | sort -u)
rm -f "$defined_file"
if [ -n "$undef" ]; then
  report "Reference to undefined CSS variable(s) — define in index.css or fix the name:" "$undef"
fi

# 8. Tailwind default radius classes — radius is the semantic --radius-* four only.
hits=$(grep -rnE '\brounded-(sm|md|lg|xl)\b' \
  --include="*.tsx" \
  "$SRC" || true)
if [ -n "$hits" ]; then
  report "Tailwind default radius class found (use rounded-[var(--radius-chip|input|panel|dialog)]):" "$hits"
fi

# 9. Tailwind shadow classes above the 2-tier scale — shadow is --shadow-sm/md only.
hits=$(grep -rnE '\bshadow-(lg|xl|2xl)\b' \
  --include="*.tsx" \
  "$SRC" || true)
if [ -n "$hits" ]; then
  report "Tailwind shadow-(lg|xl|2xl) found (2-tier scale: use shadow-[var(--shadow-md)] or --shadow-sm):" "$hits"
fi

if [ "$fail" -eq 0 ]; then
  echo "✓ design-token guardrails clean"
  exit 0
fi

echo ""
echo "Fix the violations above, then re-run: pnpm --filter @first-tree/web lint:tokens"
exit 1
