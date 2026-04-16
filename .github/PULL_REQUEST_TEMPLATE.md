## Summary

- what changed?
- why does it matter?

## Validation

- [ ] `pnpm validate:skill`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm pack` if package contents or install/upgrade behavior changed

## Change Surface

- [ ] Thin umbrella CLI (`src/cli.ts`, package/build wiring)
- [ ] Tree product dispatcher (`src/products/tree/cli.ts`)
- [ ] Tree engine behavior (`src/products/tree/engine/`)
- [ ] Shipped tree asset payload (`assets/tree/`)
- [ ] Tree skill payload (`skills/tree/`)
- [ ] Breeze product (`src/products/breeze/`, `assets/breeze/`, `skills/breeze/`)
- [ ] Maintainer or user docs (`README.md`, `CONTRIBUTING.md`, `references/`)

## Notes

- package/install behavior changes:
- docs or tests updated to match:
- follow-up work:
