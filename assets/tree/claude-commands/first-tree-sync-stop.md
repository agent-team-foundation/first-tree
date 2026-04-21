Stop all gardener sync automation for this tree repo.

## 1. Stop local loop

Check if a `/loop` is currently running `/first-tree-sync-loop`.
If yes, use `/loop stop` to stop it. If `/loop stop` is not available,
tell the user: "Please stop the local loop manually by pressing Ctrl+C
in the session running `/loop`."

## 2. Disable cloud schedule

List all scheduled triggers with the RemoteTrigger tool (`action: "list"`).
Find any trigger whose name is `first-tree-sync`.
For each one, disable it with the RemoteTrigger tool:
`action: "update"`, `trigger_id: "<id>"`, `body: {"enabled": false}`

Do NOT delete the trigger — just disable it so it can be re-enabled
later with `/first-tree-sync-start`.

## 3. Confirm

Output:
"🌳 gardener sync stopped.
- Local loop: stopped
- Cloud schedule: disabled (not deleted)
- Restart anytime: `/first-tree-sync-start`"
