# P11 — 00 Contract Index

**Authority:** DID v1.13 §11 P11, §1.5 (C8), §4.3/§4.4, §5.3, §7.6, §8.16/§8.18/§8.19, §9.5, §12.9, §12.10; v1.7 G2/G3, v1.8 G3/G4/G5; SD v1.3 §4.5, §6.2, §6.5, §7.6, §11 全章, §13.6, §14 No.26/43/50/52/56; P1 `02`/`04`/`06`, P2 `00`/`01`, P4 `01`/`02`/`04`/`05`/`08`, P5–P10 boundaries; GQ1–GQ5 裁决（2026-09-22，本会话——含 scope fence 与五项 closure invariants）.
**Status:** FROZEN (first draft for contract review).

## Governance decisions (recorded; zero DID catalog changes required — all contract-level)

| GQ | Decision | Placement |
|---|---|---|
| GQ1(a) | Worktree lifecycle formal shape (commands/states/payload/terminal paths); names follow existing domain vocabulary | `09` |
| GQ1(b) | P11 wires the **minimal** ownership write path (claim/release real call sites, RetireWorkspace→release, worktree↔ownership consistency, idempotency/atomicity). **Scope fence**: no ownership redesign / lease/TTL/preemption / multi-owner / distributed locking / arbitration | `10` |
| GQ2 | Drift v1 = explicit snapshot-diff; startup probe via P9 hook; watcher (P12) may only be a probe trigger, never a truth source | `05` |
| GQ3' | Revision algebra: per-project monotonic counter (`EnvironmentRevision`) fully separated from content `EnvironmentFingerprint`; no ordering on fingerprints; ABA detected by counter progression; anchor advances **only** via RecordEnvironmentChange (lazy-init exempt); payload carries expectedRevision + prev/next fingerprint + snapshotBlobRef | `01`/`03` |
| GQ4 | `VerificationState = Verdict × Freshness` (PASS+CURRENT / PASS+STALE / …); drift preserves verdict, marks stale, raises Attention; re-verify is policy/human. ControlBasis.environmentRevision reads the real store inside the service (no caller-passed revision) | `07`/`08` |
| GQ5 | "Wake broad, invalidate narrow": project-global revision progression wakes; changedRegions narrow the stale set; no region revision algebra | `06` |

## Documents (per the mandated ordering)

| Doc | Owns |
|---|---|
| `01-revision-algebra.md` | EnvironmentRevision (counter) / EnvironmentFingerprint separation; anchor rules |
| `02-snapshot-fingerprint.md` | Snapshot blob content/addressing; fingerprint derivation |
| `03-record-environment-change.md` | Command payload/authority/CAS; EnvironmentChanged event + wake production |
| `04-real-resolver.md` | Real ProjectEnvironmentPort (FileTree/GitWorktree probing); observation-only |
| `05-drift-detection.md` | Explicit snapshot-diff; startup probe seam |
| `06-impact-evaluation.md` | Wake-broad/invalidate-narrow impact function |
| `07-staleness-invalidation.md` | Verdict×Freshness; Attention; re-verify as decision |
| `08-controlbasis-binding.md` | Service-internal revision read; DecisionStale activation |
| `09-worktree-lifecycle.md` | Command family/states/payload/terminal paths |
| `10-ownership-wiring.md` | Minimal claim/release wiring + scope fence |
| `11-startup-recovery.md` | Startup drift probe; worktree damage recovery; sandbox-root ephemerality |
| `12-sandbox-handoff.md` | SandboxPort continuity; advanced adapter; P4 guarantees inherited |
| `13-verdict-consumer.md` | P8 binding unchanged; stale overlay integration |

## Boundaries (explicitly out of P11)

- P12 watcher/transport; ownership protocol redesign, leases/TTL/preemption, multi-owner, distributed locking, arbitration; region revision algebra; verdict mutation on drift; implicit revision advance in resolver/probe.

## Five closure invariants (review targets)

```text
CI-1  every environment mutation has exactly one legal revision-advancement path
      (RecordEnvironmentChange; lazy-init exempt)
CI-2  every environment-aware consumer binds a real ControlBasis revision
      (service-internal read; no hardcoded/caller-passed revisions)
CI-3  every worktree terminal path closes ownership (release; RetireWorkspace)
CI-4  every drift path converges to RecordEnvironmentChange or NoDrift
CI-5  every stale transition preserves the original verdict immutably
```

## Contract review (CI-scoped, independent)

| CI | Verdict |
|---|---|
| CI-1 single advancement path | **PASS** after fixes: R1 (B2) lazy-init trigger unified to the frozen P1-DG-08 semantics (first successful ownership write; counter starts "1"); R2 (B3a/b) sandbox worktree-add routed through `09` commands + WorktreeLifecycle-cause REC; write-back converges via Governance-cause REC (no unrecorded CURRENT window); R3 (B4) CAS retry = one full re-probe loop, second conflict → Attention |
| CI-2 real ControlBasis binding | **PASS** (clean on first review): service-internal read; driver hardcode removal recorded; no caller-passed revision path anywhere |
| CI-3 worktree terminal closure | **PASS** after fixes: R4 (B1) RetireWorkspace **enforces** the frozen §1.4A precondition (no auto-release; typed rejection points to release paths) — no silent DID semantics change; R5 (B3c) adapter-created worktrees gain terminal paths (ephemeral-at-close / persistent-for-integration) |
| CI-4 drift convergence | **PASS** after fixes: R3 bounded CAS loop; R6 (LOW) startup probe pinned before the runnable-set rebuild (same-pass wake); NoDrift ∥ governed REC remain the only exits |
| CI-5 verdict immutability | **PASS** (clean on first review): overlay is pure derivation; stored rows never change; forbidden transitions verbatim; LOW wording fix applied |

Review round 1 (independent): 4 Blocking (2 HIGH / 2 MEDIUM) + 3 LOW — all fixed above.

**Blocking = 0. All five closure invariants closed.**

## Status

```text
DESIGN/CONTRACT CLOSED (reviewed Blocking=0; CI-1..CI-5 all PASS).
Implementation planning may now be generated.
```
