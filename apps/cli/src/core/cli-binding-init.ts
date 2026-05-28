// Side-effect module: install the channel-resolved CLI identity into
// `@first-tree/client` so runtime helpers (bootstrap.ts's `generateToolsDoc`
// and `installFirstTreeIntegration`) emit the correct binary name
// (`first-tree` / `first-tree-staging` / `first-tree-dev`) and the correct
// npm package name for `npx <pkg>@latest` fallbacks.
//
// Imported as the first @first-tree-touching statement by every entrypoint
// that boots `ClientRuntime`:
//   - `apps/cli/src/cli/index.ts` (production CLI entry — daemon, login, …)
//   - `apps/cli/scripts/e2e-auto-agent-add.ts` (dev smoke that starts a real
//     ClientRuntime without going through Commander)
//
// History: pre-multi-env both call sites baked "first-tree" into the
// agent-facing tools.md, so staging / dev agents asked to "first-tree chat
// send …" which only existed on prod-installed hosts. This sink keeps the
// channel-derivation logic in `packages/shared/src/channel` and the client
// runtime decoupled from `apps/cli/build-info.ts`.
import { setCliBinding } from "@first-tree/client";
import { channelConfig } from "./channel.js";

setCliBinding({ binName: channelConfig.binName, packageName: channelConfig.packageName });
