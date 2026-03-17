(pi-state
  (timestamp "2026-03-17T15:52:30Z")
  (repo "open-hax-openai-proxy")
  (branch "main")
  (remote "origin/main")
  (base-head "b6c18a0")
  (previous-pi-head "b6c18a0")
  (previous-pi-subject "Π: snapshot 2026-03-17T00:12:58-05:00 [main] (4ba3881)")
  (dirty-before true)
  (intent-clean-after true)
  (changes
    (entry (status " M") (path "receipts.log"))
    (entry (status " M") (path "src/lib/provider-strategy.ts"))
    (entry (status " M") (path "src/lib/request-log-store.ts"))
    (entry (status " M") (path "src/tests/factory-strategy.test.ts"))
    (entry (status " M") (path "src/tests/request-log-store.test.ts"))
    (entry (status "??") (path "specs/drafts/factory-4xx-diagnostics.md"))
  )
  (summary
    "Persist upstream error summary fields and sanitized Factory 4xx diagnostics in request logs."
    "Record hashed/prompt-shape Factory diagnostics so prompt rejections are debuggable without storing raw prompt text."
    "Add regression coverage for Factory diagnostics persistence and request-log reload behavior."
    "Track the work in specs/drafts/factory-4xx-diagnostics.md and receipts.log."
  )
  (diffstat
    " receipts.log                        |   7 +"
    " src/lib/provider-strategy.ts        | 308 +++++++++++++++++++++++++++++++++++-"
    " src/lib/request-log-store.ts        | 141 ++++++++++++++++-"
    " src/tests/factory-strategy.test.ts  |  99 ++++++++++++"
    " src/tests/request-log-store.test.ts |  62 ++++++++"
    " 5 files changed, 611 insertions(+), 6 deletions(-)"
  )
  (verification
    (check (status "pass") (command "pnpm run build"))
    (check (status "pass") (command "pnpm test (253/253)"))
  )
  (open-questions
    "Should the sanitized Factory diagnostic shape later be generalized beyond Factory 4xx responses?"
  )
  (notes
    "Artifacts capture the pre-snapshot base head; the final Π commit/tag are created after artifact assembly."
    "Push is attempted after the snapshot commit is created; final push status is reported via git/assistant output."
  )
)
