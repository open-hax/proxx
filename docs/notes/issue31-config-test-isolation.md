# Configuration test environment isolation

[Issue #31](https://github.com/open-hax/proxx/issues/31) is the canonical repair
record. Its accepted scope includes every configuration test using `withEnv`,
not only the first test from the historical branch. The prior PR #336 and
its duplicate #385 were closed without merge; their one-line change is evidence
of incomplete coverage, not the new implementation baseline.

## Outcome and scope

Explicitly serialize all seven tests that mutate `process.env`, retaining their
configuration assertions and their `finally` cleanup. Validate the suite under
its normal runner and a concurrent parent suite, including environment
restoration after the complete suite. No provider policy, runtime configuration,
shared service, package manifest, lockfile, or other test fixture changes.

## Acceptance and verification

- Every existing `withEnv` test is explicitly non-concurrent.
- All seven original configuration assertions pass.
- A concurrent parent suite leaves the ambient environment unchanged after
  all children finish; no environment values are printed in diagnostics.
- Verification executes source through pinned tsx 4.20.6 using an isolated
  temporary npm cache. It does not reuse another checkout's node_modules,
  write the shared npm cache, or start a server.
- Diff hygiene passes and receipts preserve their existing history.

## Board and review boundary

Issue #31 retains its existing accepted GitHub projection. No repository-local
parser or shadow Rheos board implementation is added. No operational transition,
planning approval, native review verdict, or runtime/deployment result is inferred
from this plan or from local test success. PR qualification remains separate.
