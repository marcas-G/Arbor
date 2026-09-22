# P11 — 03 RecordEnvironmentChange (GQ3' payload; CI-1 anchor)

**Authority:** GQ3' 裁决; DID §4.3 (P11 owns), §5.3, §12.10 (environment row), §8.16; P1 `02` §"record" seam.
**Status:** DRAFT.

## 1. Command (the single legal advancement path)

```ts
RecordEnvironmentChange {
  projectId,
  expectedRevision: EnvironmentRevision,   // CAS: stale observer must not overwrite newer state
  previousFingerprint: EnvironmentFingerprint,
  nextFingerprint: EnvironmentFingerprint,
  snapshotBlobRef: EnvironmentSnapshotRef, // witnesses the NEXT state
  changedRegions: CanonicalResourceRegion[],
  cause: "ExternalDrift" | "Governance" | "WorktreeLifecycle"
}
```

- Authority: `System` (drift handler after governance confirmation; worktree lifecycle handler) or explicit `AuthenticatedHuman`. Drift probe results are **proposals** — the command is submitted only after the governance confirmation step (`05`).
- CAS: `expectedRevision != current` → `DomainError.RevisionConflict`. **B4 fix (CI-4)**: the caller must re-run the **full loop** — probe → diff → fresh proposal (new expectedRevision/fingerprints/changedRegions) — and retry **once**; a second conflict escalates to Attention (a concurrent recorder won). **Blind advance forbidden**; reusing the original changedRegions/fingerprints against a new expectedRevision is forbidden (double-jump + wrong stale set).
- Effect (one transaction): counter++ ; EnvironmentChanged event; wake production (below).

## 2. Event

```text
EnvironmentChanged { projectId, fromRevision, toRevision, previousFingerprint,
                     nextFingerprint, snapshotBlobRef, changedRegions, cause }
```

## 3. Wake production (source phase = P11)

Same-transaction scan of active WorkWaits: conditions with
`EnvironmentChanged(environmentRef, observedRevision)` where observedRevision < toRevision → clear + wake (reason `EnvironmentChanged`). Broad wake (GQ5); narrowing happens in `06`.

## 4. Prohibitions (CI-1 audit)

- Resolver/probe never submit this command autonomously for drift (only after confirmation); lazy-init writes no event; no fingerprint comparisons in the wake path.

## (mapping: CI-1, CI-4)
