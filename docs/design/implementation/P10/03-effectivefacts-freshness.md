# P10 — 03 EffectiveFacts & Freshness (GQ2/GQ5)

**Authority:** DID v1.13 G2/G5, §1.1 (EffectiveFacts | Projection), §5.4; SD v1.3 §3.2 (effective facts), §6.2 ControlBasis (P3-owned, unchanged), DID §8.19 (FreshnessRequirement — action admission, unchanged).
**Status:** DRAFT.

## 1. EffectiveFacts — the single shared canonical-state-derived projection

```text
definition inputs (frozen): Responsibility (current revision) + ResourceBoundary +
  Workspace policy caps + open Dependencies (state, binding) + current Work +
  open Verifications + unconsumed Inbox markers
materialization: P10-owned, incremental via generic consumer + on-read derive for joins
query: via ProjectionQueryPort (typed DTO, `05`)
consumers: P3 Context Builder (cognition) READS this projection — it must not
  re-derive a second copy (GQ2: single source); UI reads the same
```

- Refresh: watermark-driven (below); no P3-side caching contract changes (P3's own freshness gating for action admission stays per DID §8.19 — unchanged).

## 2. Freshness contract (GQ5)

```text
monotonic watermark      — every projection row/read carries the journal sequence
                          it reflects (watermark w)
observable lag           — readers can compare w against canonical lastSequence L;
                          lag = L − w is exposed on every query response
explicit barrier         — queries may pass FreshnessRequirement {minWatermark} (GQ5
                          frozen form) or {maxLag} (**contract-level extension**: a
                          watermark expressed as acceptable lag; same mechanism, no
                          new semantics); the port blocks (bounded catch-up read) or
                          refuses with a typed staleness marker when unmet
no implicit RYW          — writers get no read-your-writes guarantee; a reader that
                          needs it passes the barrier explicitly
stale recovery           — retry / catch-up / rebuild per DID §5.4 (P1 `05` §6, P9-hardened)
```

- The barrier reuses the `FreshnessRequirement` vocabulary (DID §8.19) at the projection boundary; action-admission semantics in P3/P4 are untouched.

FT-DG-01 OPEN-3's P1 `WorkspaceResourceActivationChanged` event participates
in the existing project sequence and may wake the generic Attention consumer.
The activation source itself is reconciled directly from the current P1 intent
table by P12 post-commit/startup hooks and by P10's event handler; this source
reconciliation does not read, reset, or advance the shared P1 consumer offset.
It can therefore become current even while that generic offset is below the
retained journal floor, without claiming the generic consumer caught up. There
is no new read-your-writes guarantee or filesystem lookup on the Attention
query path; callers that require fresher journal-derived Attention use the
existing watermark/barrier contract.

## 3. Must Not Decide

- No RYW SLA; no clock-based freshness (sequence watermark only).
- No changes to P3 ControlBasis/DecisionStale semantics.


## V21 Native Sandbox exact effective-facts freshness

A P9 SandboxProviderUnavailable fact is live only when strict fact/codec and
identity validation passes; exact committed P1 decision and joined command
result match Project/Workspace/Execution/full EpisodeBinding; policyRevision
matches and no newer committed revision exists; canonical Execution remains
same and nonterminal; active Step is the exact SandboxUnavailableV1 disposition
naming attentionFactId; row policy_digest equals the canonical full
effectivePolicySnapshot digest joined from commands.result_json; and
provider/version/capability/profile/network/OS/evidence tuple is
exact. Expired decisions do not erase immutable facts, but do not render
Committed; higher policy revision, terminal/stopped Execution or changed
Episode makes the old fact stale for active Attention only. No time-only
freshness, P11 EnvironmentRevision, ordinary writes, dirty state, mtimes or
filesystem lookup enters this predicate. TrustedLocal is a separate
Unconfined variant and omits registry fields from its basis and P1 registry
branch precondition. Its common full authority-bundle revision/digest is still
currentness input; any bundle child change, including registry-only change,
stales TrustedLocal just as it stales OsEnforced.

SandboxPolicyDecisionRequired/NeedsDecision is separately derived from a
current active Execution and either (a) the existing exact pending NotAdmitted
invocation whose policy is absent/stale, or (b) the accepted exact pre-intent
P3 Pending Executable Action plus Pending/unconsumed approval requirement when
the policy is absent. It is not a provider-unavailable fact or a new persisted
Attention/requirement row. V21
SandboxRecoveryBindingFailure is derived from P4 invocation/binding evidence
with its own integrity rules and must never be conflated with current source
drift or provider-unavailable freshness.

## Accepted candidate-read-model V5 full-bundle currentness

For both committed policy variants, P10's status/currentness projection
compares the exact V21 `SandboxEnvironmentBasisDigestV1` and the complete
current P5 `SandboxAuthorityBundleV2` `authorityBundleRevision/Digest` to
the immutable decision snapshot. Any child change makes the policy stale;
TrustedLocal's variant continues to omit provider-registry fields, but the
shared full-bundle pair already stored in its snapshot detects a registry-only
bundle change. The earlier V21 registry-drift exclusion is superseded.

`NeedsDecision` is derived only when the exact visible active
Execution/Episode has an exact P4-proven post-intent or accepted pre-intent
policy requirement and its current decision is absent or stale under that
full-bundle and basis comparison. P10
does not create requirement state, Attention state, or policy selection. A
provider registry change can pause TrustedLocal Work and require explicit
human reconfirmation; it never adds an OS-provider dependency or changes
TrustedLocal's unconfined meaning. Candidate read and `NeedsDecision` share
the existing Workspace Detail freshness/read barrier; generic lag or a typed
P4 port/authority error returns the existing error/lag behavior, never a
partial candidate list.

## Accepted pre-intent CandidateRead freshness (2026-10-21)

Under `ACCEPT_P10_P1_PREINTENT_CANDIDATE_READ_BOOTSTRAP_V1`, the same
Workspace Detail read transaction may derive the existing initial
`NeedsDecision`/candidate-read surface from the P4
`SandboxPolicyPreIntentRequirementV1`. P10 validates its exact active
Execution/Episode, current P3 action cursor, Pending executable Action
revision/input/tool identity, and exact Pending/unconsumed approval source,
including its immutable expiry. It combines that P4 proof with the existing P1 decision/result, full
P5 bundle and P11 complete boundary/ownership barrier. It emits no candidate
if source is missing, ambiguous, corrupt or stale. P1 checks approval expiry
against trusted GatewayNow inside its final transaction; a time-only expiry
does not mutate or delete the P4 source row. The candidate DTO
and Attention/source unions are unchanged; P10 writes no requirement,
approval, Attention, queue, marker, event or decision. After
`ResolveExecutableApproval`, the pre-intent source is no longer eligible; if
the P4 claim has created a NotAdmitted invocation, the existing post-intent
requirement path applies. P9 terminal provider-unavailable behavior is
unchanged.
