# Current recovery closure audit — `772ba5d7`

Date: 2026-10-24
Audited/tested candidate: `772ba5d713032fbccd7623264f5b664bee22f4a9`
Method: reconcile the latest independent recovery review with the exact-SHA
complete-coverage release summary and the implementation/result records below.
No production source or design document is changed by this audit.

## Current disposition on the tested candidate

The release runner summary at
`.test-results/2026-10-24T12-31-19-483Z-29480/summary.md` reports
`Status=passed`, `completeCoverage=true`, 64 selected files, six executed in
the resumed run, 58 inherited from a compatible resume, and UI 10/10. This
audit records the scoped default-matrix recovery result; it does not extend
coverage to the pending cases listed below.

| Area | Current scoped disposition | Boundaries retained |
|---|---|---|
| AH7 supported v1 paths | Accepted DG-01/DG-02/DG-03 implementation paths pass in the current default recovery matrix. The qualification boundary includes shell@3 as NonIdempotent and legacy shell@2 as fail-closed without the required trusted proof/profile. | Copied same-holder concurrent ToolRuntime invocation is explicitly unsupported; it is not a production guarantee or a pending failure. This scoped default PASS does not qualify the four pending exact cases below or arbitrary external-effect profiles. |
| AH10 registered paths | Active registered/default AH10 paths, including Deliver, verification actions and P41 Submitted DecisionEpisode recovery, pass in the current default matrix. | Do not revive the older pending Deliver/registered-route status as a release blocker. The separate Submitted corruption-semantics choice remains open and its exact pending case is not part of this pass. |
| AH14 ambiguous legacy Attention | Implemented and covered by the two default process files `agent-loop-ah14-legacy-adoption-crash.functional.test.ts` and `agent-loop-ah14-legacy-attention-crash.functional.test.ts`, which passed in this release run. The old missing-Attention RED is superseded for the current candidate. | The implementation/result remains scoped to the accepted legacy evidence and current schema path; no preserved database was migrated. |
| P8 / F23 production paths | Core production RetryVerification and F23 receipt/codec paths are implemented and exercised by the registered default matrix; mark those core paths closed at this scope. | Four exact process cases remain outside the current promoted/default matrix. P6 public read qualification is still open; operator-only offline rebuild evidence is not public-read qualification. |

Older records such as `AH-recovery-cross-generation-matrix-audit.md`,
`AH14-legacy-adoption-partial.result.md`, the older release-blocker matrices,
and the 2026-10-07 open-governance queue are preserved historical evidence.
Their blanket AH7/AH10/AH14 open labels are superseded only for the supported
v1 paths and candidate stated here; they are not rewritten or used to erase
their original failures.

## Still open

1. **Four exact cases awaiting promotion into the default matrix:**
   - `tests/functional/pending/ah10-verification-recorded-at-fingerprint.functional.test.ts`
   - `tests/functional/pending/p8-conclusion-criteria-snapshot.functional.test.ts`
   - `tests/functional/pending/f23-retry-verification-permanent-replay.functional.test.ts`
   - `tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts`

   A separate `test_dependency_selection_audit` is migrating these cases to
   default selection. Until that promotion and its exact-SHA run complete,
   this candidate's `completeCoverage=true` is only complete for the current
   64-file release manifest.
2. **P6 public read qualification** for the F23 UnboundLegacy disposition.
   Operator-only offline rebuild is a different, already-qualified scope and
   does not prove a public read route.
3. **Submitted DecisionEpisode corruption semantics:** the choice of durable
   terminal/Attention/reconciliation disposition remains owner-governed; do
   not count the isolated negative cases as PASS or invent the behavior.
4. **Native OS sandbox:** no provider is Supported; current probes do not
   establish production filesystem/network/broker/stop enforcement.
5. **Real-provider behavior:** the S1 real pass is a bounded slice with
   separate test/runtime source SHAs; S2 Normal has a terminal Verification
   failure (while immediate Stop passed); S3 stalled at a settled no-producer
   AnyProducer wait; S4-B did not reach Executable approval/restart. These
   remain real-environment qualifications, not scripted-test gaps.
6. **Existing user database:** schema-52 disposable migration evidence does
   not qualify or authorize an online/preserved database upgrade.

The local check, complete-coverage functional profile, and package gates pass
on this candidate. They do not close the six items above or create a general
release-readiness claim.

## Evidence index

- Current release summary: `.test-results/2026-10-24T12-31-19-483Z-29480/summary.md`.
- AH7 scoped implementation/review: `AH7-DG02-reconciliation-runtime-shell-v3-implementation.result.md`, `AH7-DG02-final-independent-audit.result.md`, `AH7-DG-03-approved-executable-route-audit.result.md`, and `AH7-DG-01-P40-expectedfailure-process-replay.result.md`.
- AH10 registered takeover and Submitted DecisionEpisode/P41 paths: `AH10-generation-command-takeover-gap.result.md` and `AH10-P41-submitted-decision-binding-process-qualification.result.md`.
- AH14 implementation: `AH14-legacy-adoption-attention-implementation.result.md`; current release default coverage is the two AH14 process files named above.
- P8/F23 production implementations and remaining exact test scope: `P8-retry-verification-implementation.result.md`, `F23-permanent-replay-origin-implementation.result.md`, and the four exact pending files in the open list.
