---
uuid: "inbox-worktrees-proxx-pr-156-coderabbit-kanban-inbox-worktrees-proxx-pr-156-coderabbit-specs-drafts-ui-preferences-localstorage-md"
title: "Spec Draft: UI preferences persisted in localStorage"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.148Z"
source: "inbox/worktrees/proxx-pr-156-coderabbit/specs/drafts/ui-preferences-localstorage.md"
category: "specs"
---

> Source: `inbox/worktrees/proxx-pr-156-coderabbit/specs/drafts/ui-preferences-localstorage.md`
> Migrated-to-kanban: `inbox/worktrees/proxx-pr-156-coderabbit/kanban/drafts/ui-preferences-localstorage.md`

# Spec Draft: UI preferences persisted in localStorage

## Goal
Persist user-chosen UI preferences for togglable controls in the proxy web console so they survive reloads.

## Scope
Add localStorage-backed state for:
- Dashboard: window (daily/weekly/monthly), account sort, provider filter.
- Chat: selected model, last active session id.
- Images: selected model, prompt.
- Tools: model input.
- Credentials: reveal-secrets toggle, account grouping, account search text, request-log provider/account filters.

## Non-goals
- Persisting sensitive secret inputs (API key value, OAuth tokens).
- Server-side persistence of preferences.

## Design
- Add a small helper hook `useStoredState()` in `web/src/lib/local-storage.ts`.
- Each page uses that hook for relevant `useState` values.
- Validation is applied for enum-like values to avoid breaking on old/invalid stored values.

## Risks
- Persisting `revealSecrets=true` could reveal secrets on page load for anyone with browser access.

## Definition of done
- Preferences listed above reload correctly after refresh.
- `pnpm test` + `pnpm run web:build` pass.
