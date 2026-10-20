# P5 — Contract Index

**Authority:** DID v1.9 (phase-scoped closure). These documents are **not** a
fifth design layer; they are the P5-owned implementation contracts authorized by
DID §13. P5 is an **integration phase** (DID v1.9 G1–G7): it wires the frozen
P1–P4 subsystems and does not redesign them.

```text
Detailed Implementation Design v1.9 (frozen)
        ↓ delegates phase-scoped closure
docs/design/implementation/P5/**   (these contracts)
```

## Documents

| Doc | Owns |
|---|---|
| `01-composition-root.md` | minimal runnable `apps/*` composition root, layer wiring, runtime lifecycle (dispose/reconstruct) |
| `02-runnable-work-source.md` | provisional single-workspace `RunnableWorkSource` implementation of the P2 port |
| `03-directive-handling.md` | `DirectiveUnsupported` directive execution result + the slice's supported/unsupported directive set |
| `04-slice-continuity.md` | multi-turn Session continuity across Executions, Yield → WorkWait → wake, CompletionClaim, restart-continuity proof |
| `05-slice-acceptance.md` | the single full vertical-slice acceptance story |
| `00-contract-index.md` | this index |

## P5 scope (DID §11 P5)

A long-lived Workspace Agent completes Work across multiple Executions, Session
continuation, Tool effects and restarts, and emits a `CompletionClaim`.

## DID v1.9 governance inputs

| Ruling | Closed by |
|---|---|
| G1 minimal runnable `apps/*` composition root + deterministic e2e acceptance suite | `01`, `05` |
| G2 provisional single-workspace `RunnableWorkSource` (P2 port); P7 supersedes | `02` |
| G3 `DirectiveUnsupported` for P6/P7 directives | `03` |
| G4 CompletionClaim settles Execution only; Work stays Open; P8 owns verification | `04`, `05` |
| G5 P5 owns representative restart-continuity proof; P2 mechanism; P9 hardening | `04` |
| G6 deterministic Fake Provider sufficient; real provider non-gating | `01`, `05` |
| G7 one full vertical-slice acceptance story | `05` |

## Boundaries (explicitly out of P5)

- P6: multi-workspace formation, delegation, `ProposeChildWorkspace`/specialist spawn.
- P7: `DeclareDependency`, full dependency-aware runnability (supersedes `02`).
- P8: `CompletionClaimed` → `StartVerification` → Acceptance → `CompleteWork`.
- P9: systematic fault-injection recovery hardening.
- P11: advanced environment / worktree isolation.

## Contract review (round 1)

| # | Finding | Classification | Resolution |
|---|---|---|---|
| F1 | step-16 wording artifact in the acceptance story | editorial | corrected (`05` §1) |
| F2 | `Communicate` / `RequestGovernance` handling in P5 | P5 phase-scoped | recorded as non-fatal Observations; no outbound/governance routing in P5 (`03` §2) |
| F3 | provisional `RunnableWorkSource` must not alter the P2 port | P5 phase-scoped | port unchanged; provisional impl only (`02` §1) |
| F4 | restart proof must not become a new recovery mechanism | P5 phase-scoped | P2 owns the mechanism; P5 owns the acceptance proof only (`04` §4) |

**Blocking = 0.** No open P5 Design Gap.

## Status

FROZEN (contracts) — independent review round 1 complete, **Blocking = 0**.
No P5 planning is generated until the phase plan + tasks are derived from these
contracts.

## Accepted full-chain Native Sandbox authority/configuration owner

P5 `01` loads and validates the current SandboxAuthorityBundleV2 from the
protected deployment source and exposes one immutable snapshot to P1/P4. It
owns exact issuer/operator/registry codecs, OS-protected source identity and
independent monotone V2 high-water, versioned safe error/audit ADTs and
fail-closed unavailable behavior. V1 source/high-water/audit bytes remain
immutable forensic history only; they do not authorize new policy decisions
after V2 activation. No daemon auto-initialization/reset, default issuer, hot
reload or allow-all mode exists. V21 derived RecoveryBinding Attention uses
existing P4/P9 data and does not alter this source contract.

## Accepted Native Sandbox producer mapping closure (V3)

P5/01 closes operator policy configuration inside the versioned bundle,
including fixed `trustedLocalRuntimeVersion=builtin-v1`, exact revision/digest
mapping, V1-to-V2 protected high-water preservation and immutable audit
compatibility. See P5/01 and the V3 acceptance record/manifest.

## Accepted Sandbox Policy Candidate Read Model V5

P5/01 supplies one fully validated immutable SandboxAuthorityBundleV2
snapshot and exact current-host Supported tuples only. It does not filter
Workspace applicability, choose a policy, expose provider evidence refs, or
gate dispatch. P10 owns the candidate read; P4 owns requirement proof and P1
owns command CAS. See the V5 acceptance record.

## Accepted Option A exact provider selector (2026-10-20)

P5/01's existing V2 Supported tuple/evidence is the sole source for P1's
exact providerVersion/capabilityRevision match. Current host remains trusted
process-local input; registry codecs, uniqueness, high-water and migration
contracts are unchanged. Accepted proposal SHA-256
`02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`.
