# P11 — 11 Startup Recovery Seam (GQ2)

**Authority:** GQ2 裁决; P9 recovery-drive (startup hook); SD §10.6 step 4.
**Status:** DRAFT.

## 1. Startup drift probe (frozen)

The P9 `startupRecovery` pass (step ordering unchanged) appends after canonical settle (step 6) and **before the runnable-set rebuild (step 7)** — so an auto-submitted change wakes candidates within the same pass: `probeDrift(projectId)` → DriftReport surfaces via Inbox/Attention; auto-submit of RecordEnvironmentChange only under explicit configuration (default off). Convergence target per CI-4.

## 2. Worktree damage recovery

Startup lists Active worktrees whose probe shows missing/corrupt → Attention rows + governance-suggested `materialize-again` (idempotent re-materialization; files recreated only on confirmation).

## 3. Sandbox-root ephemerality

mkdtemp roots are ephemeral by design (P4 contract); P11 documents (not changes) this — advanced worktree-backed roots (`12`) persist with the worktree.

## (mapping: CI-4)
