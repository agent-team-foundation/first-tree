import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Re-point intra-monorepo imports to the source `.ts` entry instead of the
// built `./dist/*.mjs`. Without this, vitest must resolve cross-package
// imports through each package.json's `import` condition, which forces
// `turbo test` to declare `dependsOn: ["^build"]` and `tsdown`-builds every
// dependency before tests can run. With these aliases, vite/vitest compile
// the .ts source on the fly via its own transform, so the `^build` step
// (5-15s on a cold CI run) drops out entirely.
//
// The runtime / publish paths (the `import` condition consumed by Node, by
// `tsdown` when it inlines `client`/`shared` into the published `command`
// tarball, and by Vite's prod build for `web`) are untouched.
const root = fileURLToPath(new URL("..", import.meta.url));

// Array form (not object) so each alias matches exactly with an anchored
// RegExp. An unanchored prefix like `@first-tree/client` would
// otherwise swallow `@first-tree/client/observability` and rewrite it
// to a bogus path with `/observability` appended to the file.
export const monorepoSourceAliases: { find: RegExp; replacement: string }[] = [
  {
    find: /^@first-tree\/shared\/config$/,
    replacement: resolve(root, "packages/shared/src/config/index.ts"),
  },
  {
    find: /^@first-tree\/shared\/observability$/,
    replacement: resolve(root, "packages/shared/src/observability/index.ts"),
  },
  {
    find: /^@first-tree\/shared$/,
    replacement: resolve(root, "packages/shared/src/index.ts"),
  },
  {
    find: /^@first-tree\/client\/observability$/,
    replacement: resolve(root, "packages/client/src/observability/index.ts"),
  },
  {
    find: /^@first-tree\/client$/,
    replacement: resolve(root, "packages/client/src/index.ts"),
  },
  {
    find: /^@first-tree\/server\/observability$/,
    replacement: resolve(root, "packages/server/src/observability/index.ts"),
  },
  {
    find: /^@first-tree\/server\/config$/,
    replacement: resolve(root, "packages/server/src/config.ts"),
  },
  {
    find: /^@first-tree\/server$/,
    replacement: resolve(root, "packages/server/src/app.ts"),
  },
];
