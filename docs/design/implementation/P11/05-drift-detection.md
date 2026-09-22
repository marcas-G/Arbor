# P11 — 05 Drift Detection (GQ2)

**Authority:** GQ2 裁决; SD §11.5; P9 startup hook (recovery-drive).
**Status:** DRAFT.

## 1. v1 = explicit snapshot-diff (frozen)

```text
probeDrift(projectId):
  capture = real resolver full-region probe → candidate fingerprint + candidate snapshot
  anchored = latest snapshot bound to the anchor revision
  candidate.fingerprint == anchored.fingerprint  → NoDrift
  else → DriftReport { changedRegions (region-level diff), candidateSnapshot }
```

- DriftReport is a **proposal**; convergence (CI-4) requires either NoDrift or a governed `RecordEnvironmentChange` (cause ExternalDrift) submitted after human/system-operator confirmation (Story-level: the startup probe auto-submits only when configured `autoConfirmExternalDrift` — default false).
- Startup seam: the P9 startup recovery hook calls probeDrift once (see `11`).

## 2. P12 watcher boundary

A future watcher may only *trigger* probeDrift; it is never a truth source and never advances the anchor.

## 3. Must Not Decide

- No continuous watch, no fs events, no debounce semantics (P12); no auto-submit by default.

## (mapping: CI-4)
