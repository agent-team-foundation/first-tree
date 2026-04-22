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

if [ "$fail" -eq 0 ]; then
  echo "✓ design-token guardrails clean"
  exit 0
fi

echo ""
echo "Fix the violations above, then re-run: pnpm --filter @first-tree-hub/web lint:tokens"
exit 1
