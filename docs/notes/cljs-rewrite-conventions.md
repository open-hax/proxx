# Proxx TypeScript → ClojureScript rewrite: conventions

Goal of the rewrite: capture the **intent** of each TypeScript module as
functional, immutable Clojure — not a line-by-line transliteration. The epic is
`proxx-typescript-to-cljs-runtime-migration` (see
`scripts/typescript-inventory-allowlist.json` for the per-file task owners).

Worked examples to read first (all verified differentially against the TS):

| Pattern | Read |
| --- | --- |
| Pure translation over wire data | `src/proxx/compat/messages.cljc` + `test/proxx/compat/messages_test.cljs` |
| One parse pass, predicates over a sequence | `src/proxx/sse.cljc` |
| Verdicts over parsed facts; edge reads the body only if needed | `src/proxx/errors/classification.cljc`, `src/proxx/runtime.cljs` (`response-indicates-*`) |
| Mutable class → immutable state machine + atom at the edge | `src/proxx/keypool/pool.cljc`, `src/proxx/runtime/keypool.cljs` |
| Policy facts in EDN, interpreted in CLJS | `src/proxx/compat/wire_profile.cljc`, `resources/policies/runtime/75-provider-wire-profiles.edn` |

## Layering ("purify before you port")

1. **Pure core, `.cljc`** under `src/proxx/<area>/`. Data in, data out. No
   `js/`, no `Date.now`, no `Math.random`, no atoms, no I/O. Time is a `now-ms`
   argument; randomness is an explicit PRNG value (`proxx.keypool.pool/next-double`);
   JSON goes through `proxx.json`; hashing is an injected `sha256-hex` fn.
2. **Edge, `.cljs`** under `src/proxx/runtime/<area>.cljs` (or `proxx.runtime`):
   converts JS ⇄ CLJ, owns atoms/timers/streams/fetch/fs/db, sequences effects
   around pure decisions, and exports through `shadow-cljs.edn` `:exports`.
3. **TypeScript** keeps its exported signatures and becomes a thin entry point
   that calls `kernels.*` from `src/lib/cljs-kernels.ts`. TS callers do not change.

Split the *decision* from the *effect*. If a function fetches then decides,
port the decision over already-fetched facts and leave the fetch at the edge
(see `quota-body-needed?` – the edge only reads/clones a body when the head
leaves the question open).

## Data and idiom

* **Wire payloads are string-keyed maps.** Provider fields we do not understand
  must survive untouched, so never keywordize them. Internal domain values
  (credentials, pool state) use keywords; convert at the edge only.
* Prefer `reduce` over an accumulator map to mutable locals; tables (maps/sets)
  to `if` chains; `some`/`keep`/`group-by` to index loops; `cond->` to
  build-then-conditionally-assoc. Return `[value state']` from every operation
  that yields both.
* Domain failures: `(throw (ex-info msg {:error/type ::kw ...}))`; the edge
  rethrows as `js/Error` with the same message so the HTTP layer is unchanged.
* **Provider/model/route facts do not belong in CLJS code either** — they are
  EDN contracts under `resources/policies/runtime/` interpreted by CLJS
  (`AGENTS.md`). New contract kinds need a Malli schema in `proxx.schema`, a
  manifest entry in `00-manifest.edn`, and tests.
* Untrusted ≠ ill-typed: tolerate and drop malformed provider values; reject only
  what cannot be honoured.
* Async: `defn ^:async` / `(await …)`, never `js-await`.

## Closure advanced-compilation hazards (the release build)

* Reading properties of host objects: hint them `^js` (`[^js store]`) so externs
  are inferred. **A `:infer-warning` in the release build is a bug**, not noise:
  an unhinted `(.-prop o)` can be renamed. `pnpm build:cljs` must show 0 warnings
  for files you touch.
* **Writing** properties on a JS object: use `(aset o "name" v)`, never
  `(set! (.-name o) v)` (renamed → `hh`).
* `js->clj` returns `process.env` unchanged (not a plain Object); copy
  `Object.keys` explicitly.

## Equivalence: prove it, do not assume it

For every ported module build a throwaway differential harness (keep it out of
the repo): a `tsx` script that imports both the original TS and
`dist/cljs/proxx-runtime.js`, pins `Date.now`, replays identical RNG streams,
and compares canonicalised JSON (key-order-insensitive) over a large generated
corpus plus the existing TS test fixtures. A harness that reports zero diffs on
a corpus that never exercises the interesting branches proves nothing — generate
degenerate inputs (empty strings, `null`, arrays where objects are expected,
numbers as strings).

**Diffs must be classified, never waved away.** Either it is a bug in your port
(fix it), a bug in the harness (fix it; e.g. calling `pick()` once per side), or
an *intentional divergence* where the TS behaviour is an accident of
JavaScript (`a ?? b` stopping at `""`, `isRecord([])` being true). Pin each
intentional divergence with a named test. **Exception: persisted identity**
(account ids, cooldown keys, anything stored) keeps TS semantics exactly.

## Wiring and gates

1. Add exports to `shadow-cljs.edn` (append only) and typed entries to
   `CljsKernels` in `src/lib/cljs-kernels.ts`.
2. Replace the TS module body with shims; keep exported names/types.
3. Gates that must pass:
   * `pnpm test:cljs` (all green) and `pnpm build:cljs` (0 warnings)
   * `npx tsc --noEmit -p tsconfig.json`
   * `pnpm check:no-new-typescript` (new TS files are forbidden; a transitional
     file needs an allowlist entry with an honest `removalCondition`)
   * `pnpm exec eslint <touched ts files>`
   * Full TS suite, identical to baseline:
     `npx tsx --test --test-concurrency=1 src/tests/*.test.ts`
     (baseline: 649 tests, 647 pass, 0 fail, 2 skipped, plus anything added).
4. One commit per module, message ending with
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
