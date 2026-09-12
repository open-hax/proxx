# PR #444 workflow recovery

Base examined: `809895c131d8dfe42a56a58ae6d7f1c5f441b3cd`.
Repository and provider metadata were read on September 12, 2026 UTC.

The legacy PR review and two issue-agent actions selected
`kimi-for-coding/k2p5`. The actual [review job](https://github.com/open-hax/proxx/actions/runs/34700603480)
failed with `Model not found: kimi-for-coding/k2p5`. All three actions now use
`opencode/big-pickle`, matching this repository's existing interactive OpenCode
workflow and the user's authorized free Zen model selection. The obsolete Kimi
secret is no longer passed to those actions. Job conditions, permissions,
review instructions and issue-management guardrails remain enforced.

The [current Zen catalog](https://opencode.ai/zen/v1/models) includes `big-pickle`
and `mimo-v2.5-free`; the [official Zen documentation](https://opencode.ai/docs/zen/)
identifies both as free and specifies the `opencode/<model-id>` configuration
format. This is observed availability, not a promise of permanent availability
or a successful new inference run. The pinned action wrapper remains unchanged.
Its [source](https://github.com/anomalyco/opencode/blob/385cb694419f98103af0e8fc6187ddcbcbb6eecb/github/action.yml)
maps `inputs.model` to `MODEL` and installs the latest CLI, so the old comment
claiming reproducible CLI behavior was corrected. The failed job installed
OpenCode v1.18.30 despite the old comment mentioning v1.15.13.

The [auto-merge job](https://github.com/open-hax/proxx/actions/runs/34700603766)
failed because squash merging is forbidden. Actual repository metadata reports
`allow_merge_commit=true`, `allow_squash_merge=false`,
`allow_rebase_merge=false`, and `allow_auto_merge=true`. The caller now selects
`MERGE`, which the existing reusable workflow accepts. No repository setting,
review gate or branch protection was changed.

## Promotion failure diagnosis

The historical [main gate](https://github.com/open-hax/proxx/actions/runs/34700603476)
failed its staging-ancestry check while the feature PR targeted `main`. Source
inspection showed that this workflow runs only for PRs targeting `main`, whose
documented path is a canonical `staging` promotion. Requiring the head to
already exist in staging is valid for that path. Live PR metadata instead shows
#444 now targets `staging`, at base `cf59b233a56d76c50b282e3e88863260a5741c17`.
The promotion gate is therefore preserved. No no-op topology test or permissive
replacement was added to turn that old failure green.

## Failure-first checks

`scripts/ci_workflow_contracts_test.clj` uses Babashka's bundled YAML reader to
parse the actual workflow inputs. Its independent capability fixture records
the observed repository merge settings and the user-authorized models present
in the live Zen catalog. It does not invoke GitHub writes or model inference.

Before the YAML changes, the native run reported **2 tests / 6 assertions,
4 failures, 0 errors**, exit 1: all three retired model selections and the
forbidden squash method. Afterward it reported **2 / 6, zero failures or
errors**, exit 0. This is an offline snapshot regression; changes to external
capabilities require refreshing the evidence rather than assuming the snapshot
remains current.

```bash
bb scripts/ci_workflow_contracts_test.clj
clj-kondo --lint scripts/ci_workflow_contracts_test.clj
actionlint .github/workflows/auto-merge.yml \
  .github/workflows/opencode-code-review.yml \
  .github/workflows/opencode-issue-agent.yml
git diff --check
```

All final commands pass. Kondo reported zero errors/warnings. Actionlint 1.7.12
ran with ShellCheck 0.11.0 available and produced no diagnostics. Babashka is
1.13.219. No npm dependencies, application source, service fixtures or model
processes changed; no full service suite was rerun for these workflow inputs.

Local logs under `target/ci-verification/`:

| Evidence | SHA-256 |
| --- | --- |
| `workflow-red.log` | `aefa6b1f07209f4a41ab2ad7a9bfa90b35233e43ea58b2eb011bfcc44ed668a9` |
| `workflow-green.log` | `6c9a25551e2b666b750f97a45cecb23a84c1e8dafd4a97c20a18acf347bceb85` |

## Tooling obstacles and self-review

- The restored checkout lacked workflow lint binaries. Pinned native releases
  were downloaded into a separate workflow-tools directory. Their archive
  SHA-256 values matched GitHub release metadata: actionlint
  `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`;
  ShellCheck `8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198`.
- Archive extraction initially failed when tar tried to restore upstream numeric
  ownership. Re-extracting with `--no-same-owner` preserved the sandbox owner
  and produced working executables.
- Kondo rejected the test's initial hyphenated filename. The file was renamed
  to its conventional underscore form; no lint rule was disabled.
- Initial GitHub metadata calls used another tool's argument names and were
  rejected. Reading the tool's full signature and using
  `repository_full_name` returned the actual settings. Browser retrieval of
  GitHub release/API URLs was unavailable; the authenticated repository tool
  and ordinary read-only release downloads supplied the required evidence.
- Self-review checked the actual reusable action and auto-merge input contract,
  preserved all job admission conditions and existing job check names, and corrected
  the mistaken promotion diagnosis before changing code.
- Independent read-only peer review found no confirmed workflow defect. It
  caught a leftover copy of the initially named test file; that owned duplicate
  was removed before commit, leaving only the underscore filename.

This slice did not publish, rerun hosted workflows, comment on the PR, enable
auto-merge or merge anything. #444 remains under the coordinating stack-wide
draft hold. Fresh hosted review and check convergence remain required after
the coordinator publishes a successor.
