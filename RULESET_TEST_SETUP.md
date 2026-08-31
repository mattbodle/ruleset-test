# Ruleset Test status-gate proof

This is a disposable proof of the status-gate mechanics for the production Safe PR Gate.
It intentionally does **not** claim to prove Rokt employee identity or the team-review
fallback: a user-owned repository cannot configure GitHub's path-aware required-reviewer
teams. The production implementation remains in `ROKT/sdk-team-context` PR #8.

The proof permits only a root `README.md` pull request from `mattbodle`, with at most one
file and 100 changed lines. It also requires the current head SHA to have a successful
`ruleset-test/bot-check` status. Any other path, author, rename, executable file, or
unavailable diff makes `Ruleset Test Safe PR Gate` `action_required`.

The Gate runs on `pull_request_target` but checks out the default branch only. It never
checks out pull-request code, submits reviews, merges, pushes, or bypasses a ruleset.

## Manual setup

After merging this PR:

1. In **Settings → Secrets and variables → Actions → Variables**, add:

   | Name | Value |
   | --- | --- |
   | `RULESET_TEST_SAFE_PR_GATE_ENABLED` | `true` |
   | `RULESET_TEST_SAFE_PR_GATE_MODE` | `audit` for the first test, then `enforce` |

   No secret, PAT, machine user, or GitHub App is needed for this personal-repo proof.
   It uses the workflow's scoped `GITHUB_TOKEN`; the required-check source can be pinned to
   GitHub Actions in the ruleset UI.

2. While the mode is `audit`, open a README-only PR from `mattbodle`. The Gate should
   complete `neutral` and say it would report success after `ruleset-test/bot-check` posts.

3. Change the mode to `enforce`. In **Settings → Rules → Rulesets**, create an active
   branch ruleset targeting `main` with:

   - **Require a pull request before merging**: enabled, **required approvals = 0**.
   - **Require status checks to pass before merging**: add `Ruleset Test Safe PR Gate`, set
     it to require the branch to be up to date, and select **GitHub Actions** as the expected
     source/integration if the UI offers the selector.
   - No bypass actors.

4. Open a second README-only PR from `mattbodle`. Expected sequence: the test bot status is
   published, the Gate succeeds on the same head SHA, and GitHub permits the merge without a
   review.

5. Open a PR that adds `probe.txt`. The Gate becomes `action_required`, and the ruleset
   blocks merging. Close this test PR after observing the result.

## What this proves and what it does not

It proves that a required, source-pinned check can safely make a path- and status-specific
merge decision on a current PR SHA. It does not prove Rokt employee membership, the
two-GitHub-App least-privilege split, or `sdk-engineering` review fallback; those require a
ROKT organization repository and are documented in the production PR.
