# Code Quality Checks

Proxx uses automated checks to keep the proxy maintainable while the runtime is split across TypeScript HTTP/database adapters, ClojureScript policy/runtime code, EDN policy contracts, and a React/Vite web console.

## Code duplication scanning

Duplication scanning is provided by [`jscpd`](https://github.com/kucherenko/jscpd) and configured in the repository root at `.jscpd.json`.

### Commands

```bash
# Generate a non-gating duplication report for local triage
pnpm duplication:scan

# Run the CI-suitable duplication gate
pnpm duplication:check
```

`duplication:scan` writes console, HTML, and JSON reports under `reports/jscpd/`. The report directory is ignored because it is a regenerable artifact.

`duplication:check` uses the same configuration with a stricter threshold and is intended for CI or pre-merge checks. The current gate fails only if total duplicated lines exceed `5%`.

The GitHub Actions workflow at `.github/workflows/code-quality.yml` runs `pnpm duplication:check` on pull requests and pushes to `main`/`staging`.

### Scope

The scan covers source-like code paths:

- `src`
- `test`
- `web/src`
- `web/test`
- `scripts`
- `resources`
- `deploy`
- `examples`
- `pseudo`

The configured formats focus on executable and policy code:

- JavaScript
- TypeScript
- JSX/TSX
- Clojure/ClojureScript/EDN-style files recognized by `jscpd` as Clojure

Markdown and JSON are intentionally excluded from the default duplication gate because specs, generated metadata, copied documentation templates, and provider catalog snapshots create high noise and hide actionable code duplication.

### Ignored paths

The scanner ignores dependency, build, generated, local-runtime, and transient artifacts, including:

- `node_modules/`
- `.venv/`
- `dist/`, `build/`, `target/`, `.target/`
- `.worktrees/`
- `.eta-mu/`, `.ημ/`
- `.shadow-cljs/`, `.clj-kondo/`, `.cpcache/`, `.lsp/`, `.vite/`
- `.factory/`, `.tmp-go-bin/`, `data/`
- generated pricing data under `src/lib/data/`
- lockfiles, sourcemaps, TypeScript build info, minified files, generated declarations, and backup files

When adding new generated directories, update `.jscpd.json` before relying on duplication results.

### Reading results

Start with the HTML report:

```bash
pnpm duplication:scan
xdg-open reports/jscpd/html/index.html
```

Treat duplicates as triage signals rather than automatic refactor mandates. Good first candidates are:

1. repeated provider strategy or route handler logic,
2. repeated CLJS policy/runtime helpers that can become pure shared functions,
3. repeated request parsing, error classification, and credential selection blocks,
4. repeated frontend page/control components,
5. repeated test setup that can become shared fixtures.

Avoid extracting duplication when it would obscure policy vocabulary, couple intentionally separate provider paths, make route aliases less explicit, or make tests harder to read.
