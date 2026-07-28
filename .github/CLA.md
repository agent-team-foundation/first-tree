# CLA operations

The `CLA` workflow is a legal and merge-control boundary. Changes to its
agreement links, signing phrase, signature schema, storage branch, action pin,
or allowlist require the same review as the workflow itself.

Before activation, the Foundation's legal owner must confirm that the public
signature fields, branch access, retention policy, and history-tampering
controls are appropriate. Repository review does not replace that legal and
records-management decision.

## Initial deployment

The pull request that first adds `.github/workflows/cla.yml` is the only
bootstrap exception because GitHub loads `pull_request_target` workflows from
the default branch. Immediately after that pull request merges:

1. Add the `CLA` GitHub Actions job to the existing required checks without
   replacing the other checks:

   ```bash
   protection="repos/agent-team-foundation/first-tree/branches/main/protection/required_status_checks"
   gh api "${protection}" |
     jq '{
       strict,
       checks: (
         .checks + [{"context": "CLA", "app_id": 15368}] |
         unique_by([.context, .app_id])
       )
     }' |
     gh api --method PATCH "${protection}" --input -
   ```

2. Read the protection back and confirm that `CLA` is present:

   ```bash
   gh api \
     repos/agent-team-foundation/first-tree/branches/main/protection/required_status_checks \
     --jq '.checks'
   ```

3. Open a verification pull request. Confirm that an unsigned human author is
   blocked, the exact ICLA signing comment records the documented fields on
   `cla-signatures`, and the same `CLA` check then succeeds.

Every non-closed workflow run validates the complete ledger after the upstream
action and any profile enrichment. A queued rerun therefore cannot make the
required check succeed when an ICLA record is missing either its base evidence
or the profile fields promised by the agreement.

If adding the required check fails, stop merges until an administrator restores
the gate. Do not weaken or replace the existing required checks as a workaround.

## Corporate coverage

Only add a GitHub username to the workflow allowlist after the Foundation has
verified an executed CCLA and confirmed that the username appears in its
Schedule A. Make allowlist changes through a reviewed pull request; do not edit
the signature ledger to grant coverage.
