---
uuid: "221ceec5-4b65-42b0-871d-0cd0b80d97be"
title: "Epic: Control-plane slice: federation v1"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.145Z"
source: "kanban/drafts/epics/federation-slice-epic.md"
category: "specs"
---

> Source: `kanban/drafts/epics/federation-slice-epic.md`
> Migrated-to-kanban: `kanban/drafts/epics/federation-slice-epic.md`

# Epic: Control-plane slice: federation v1

**Status:** ✅ Done
**Epic SP:** 8
**Priority:** P1
**Parent file:** `kanban/drafts/control-plane-slice-federation-v1.md`

## What's done
- ✅ Canonical `/api/v1/federation/self`, `peers`, `bridges`, `accounts` use modular route layer
- ✅ Advanced routes (`projected-accounts/*`, `usage-export`, `usage-import`, `sync/pull`) at `/api/v1/federation/*`
- ✅ Web console uses `/api/v1/federation/*`
- ✅ All test URLs migrated from `/api/ui/federation/*` to `/api/v1/federation/*`
- ✅ 162/162 proxy tests pass
