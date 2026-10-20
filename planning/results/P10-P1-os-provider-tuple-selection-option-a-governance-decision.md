# P10 → P1 OS Provider Tuple Selection — Governance Decision

Decision: **ACCEPTED — Option A**

Acceptance token: `ACCEPT_P10_P1_OS_PROVIDER_TUPLE_SELECTION_OPTION_A`

Accepted fixed proposal:

- Path: `planning/proposals/P10-P1-os-provider-tuple-selection-binding-draft.md`
- Git commit: `5a12bc64bd414321b8ecadb87a4b2a65a8444c3b`
- Canonical LF UTF-8 SHA-256:
  `02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`

The selected owner semantics are exactly the proposal's Option A: the closed
P1 OsEnforced command carries required `providerVersion` and
`capabilityRevision`; P10 carries `capabilityRevision` on its OsEnforced
candidate and binds it into candidate identity; P1 matches the selected
provider tuple against one exact current-host Supported row in the verified
P5 V2 authority snapshot. `candidateId` remains presentation-only. No
sorting, highest-version choice, registry uniqueness restriction, handle
digest inference, fallback, or new provider support claim is accepted.

The owner landing is limited to the implementation contracts of P1, P4, P5,
P10, P12 and P13 listed in the companion
`planning/results/P10-P1-os-provider-tuple-selection-option-a-landing-manifest.md`.
Top-level `docs/design/00-problem-goals.md` through
`docs/design/03-detailed-implementation-design.md` are not changed; no
upstream problem, scenario, system invariant or package DAG semantics are
reopened. Existing P5 V2 bundle/registry/high-water, P1 full-bundle and
registry CAS, result bytes, decision/event/receipt transaction, schema-50
DDL, public redaction, TrustedLocal behavior and runtime/provider gates remain
unchanged except for the exact selected tuple binding and command/candidate
schema versions specified by the accepted proposal.

This governance acceptance does **not** authorize production code changes,
database migration or upgrade, a Supported status change, provider
qualification, deployment or release. The next permitted step is a
SHA-pinned implementation plan with independent review. Production work must
wait for separate explicit implementation authorization.

The fixed source proposal remains unchanged to preserve the accepted hash; its
original `DRAFT` label records its pre-decision state. This decision record
and the landing manifest together record the manual acceptance and exact
owner postimages.
