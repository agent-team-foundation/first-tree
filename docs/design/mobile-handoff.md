# Mobile Experience Handoff

This handoff records the current state of the First Tree mobile web work so
another engineer can continue without re-discovering the product and technical
decisions.

## Branch And Baseline

- Branch: `feat/mobile-shell`
- Remote: `origin/feat/mobile-shell`
- Base at start of work: `origin/main` `baa17544`
- Mobile foundation commit before this handoff: `74f9276b`
- Product/design contract: `docs/design/mobile-experience.md`

## Product Decisions To Preserve

- Mobile is the daily work surface, not a compressed desktop console.
- Primary tabs are `Now`, `Chat`, `Team`, and `Me`.
- `Team` includes humans and agents together.
- Desktop remains the place for agent creation, runtime configuration, context
  tree setup, integrations, resources, and dense admin tables.
- Mobile routes should be explicit `/m/*` routes inside the existing web app.
- First phase should not require server or schema changes.

## Current Implementation State

The branch currently contains the foundation files but is not yet a complete
mobile route integration.

Added:

- `docs/design/mobile-experience.md`
- `packages/web/src/pages/mobile/data.ts`
- `packages/web/src/pages/mobile/components.tsx`
- `packages/web/src/pages/mobile/shell.tsx`
- `packages/web/src/pages/mobile/now.tsx`
- `packages/web/src/pages/mobile/chat.tsx`
- `packages/web/src/pages/mobile/team.tsx`
- `--mobile-tabbar-height` in `packages/web/src/index.css`

The current files implement:

- a mobile chat attention projection from existing `MeChatRow` data
- a safe-area-aware mobile shell component
- mobile top bar and bottom tab bar components
- Now screen backed by `listMeChats`
- Chat list/detail wrapper backed by existing chat APIs and `CenterPanel`
- Team roster backed by existing agent/member APIs

Not done yet:

- `/m/*` routes are not wired into `packages/web/src/app.tsx`
- `MobileMePage` does not exist yet
- mobile route tests are not added
- visual QA has not been performed in browser viewports
- chat detail needs product QA for header/back behavior because it currently
  wraps the existing desktop chat center in narrow mode

## Verification Already Run

These checks passed after the foundation commit:

```bash
./node_modules/.bin/tsc --noEmit -p packages/web/tsconfig.json
bash packages/web/scripts/check-design-tokens.sh
```

This command did not reach TypeScript in the local Codex environment because
pnpm stopped during dependency install with the `approve-builds` policy prompt:

```bash
pnpm --filter @first-tree/web typecheck
```

The next owner should run the normal package command in an environment where
pnpm build-script approvals are already configured.

## Recommended Next Steps

1. Add `MobileMePage`.

   Keep it small: account identity, current team, team switcher, theme, support,
   sign-out, and links to desktop settings where needed. Do not add admin
   configuration panels.

2. Wire authenticated `/m/*` routes in `packages/web/src/app.tsx`.

   Add a sibling route group under `RequireAuth`, separate from the desktop
   `Layout` group. It should wrap `MobileShell` in the same `PulseProvider`
   pattern used by the desktop workspace.

   Gate the visible mobile experience by server release channel. `dev` and
   `staging` should enable `/m/*`, phone root redirect to `/m/now`, and PWA
   metadata by default. `prod` should keep `/m/*` falling back to `/` and should
   not advertise the mobile PWA manifest.

   Target route shape:

   ```tsx
   <Route
     element={
       <PulseProvider>
         <MobileShell />
       </PulseProvider>
     }
   >
     <Route path="m" element={<Navigate to="/m/now" replace />} />
     <Route path="m/now" element={<MobileNowPage />} />
     <Route path="m/chat" element={<MobileChatPage />} />
     <Route path="m/team" element={<MobileTeamPage />} />
     <Route path="m/me" element={<MobileMePage />} />
   </Route>
   ```

3. Add focused tests.

   Minimum test coverage:

   - `mobileChatSignal` ranks needs-answer before failed, unread, working, and
     recent chats.
   - on `dev`/`staging`, `/m` redirects to `/m/now`.
   - on `dev`/`staging`, `/m/now`, `/m/chat`, `/m/team`, and `/m/me` render
     under auth.
   - on `prod`, `/m/*` falls back to the desktop root.
   - chat detail hides the mobile bottom tabs when `?c=` is present.
   - Now and Chat empty/error/loading states render without throwing.

4. QA mobile layout in browser.

   Inspect at 320, 375, 390, 430, and 768 CSS-pixel widths. Check light and
   dark mode. Verify no horizontal overflow, no bottom-tab/composer overlap,
   and no hover-only actions.

5. Decide whether to open a PR before further implementation.

   The current branch is useful as a reviewable foundation. If another engineer
   continues on the same branch, keep follow-up commits small and separate:
   route wiring, Me page, tests, visual polish.

## Risks And Watch Points

- Do not turn mobile into a responsive version of every desktop page.
- Do not move desktop-only admin functionality into the first mobile phase.
- Do not add server projections until the first client-side attention ranking
  has been validated with real usage.
- Do not rely on hover menus. Every mobile action needs a touch path.
- Watch for `CenterPanel` assumptions from the desktop workspace. The fastest
  first phase can reuse it, but chat detail may later deserve a thinner mobile
  wrapper.
- Keep the mobile shell isolated so future desktop changes do not force mobile
  regressions.

## Definition Of Done For First Visible Phase

The first phase is done when an authenticated phone-width user can:

- open `/m`
- land in Now
- see attention work from active chats
- open chat list
- open an existing chat
- start a draft chat from Now, Chat, or Team
- view humans and agents in Team
- reach account/team controls in Me

All of that should work without desktop settings, agent configuration, or server
changes.
