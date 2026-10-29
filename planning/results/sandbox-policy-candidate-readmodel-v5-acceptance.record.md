# Sandbox Policy Candidate Read Model V5 — Acceptance and Landing Record

**Decision date:** 2026-10-19

**Decision:** User accepted `ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL_V5`.

**Accepted proposal raw SHA-256:** `26B4BDAA4F79DCF2A0EA7C601A1037372A9C5308AB761663A921235076CE8D13`.

**Accepted proposal path:** `C:\Arbor\planning\proposals\sandbox-policy-candidate-readmodel-governance-v5.md`.

**Owner base:** V21 landing `e99e1c6e375bd92e04ec94a0bc5cdb9d4cd873e8`; main candidate `21863de2222552d2c0aeb8e93e21e86da226afc6` has identical owner blobs.

## Accepted semantic delta

Every committed policy variant, including TrustedLocalUnconfinedV1, is
current only while both its existing `SandboxEnvironmentBasisDigestV1` and
the complete current SandboxAuthorityBundleV2 revision/digest match. Any
bundle-child change, including registry-only drift, stales TrustedLocal; the
existing TrustedLocal snapshot/basis codec gains no registry field and its
meaning remains Unconfined. P4 retains the existing same-Execution
`SandboxPolicyRequiredInterruption` path and P10 reports derived
NeedsDecision.

P4/06 exposes a read-only proof-bearing `SandboxPolicyRequirementReadPort`
over existing P3 Pending/Executable action and P4 NotAdmitted invocation/
RecoveryBinding evidence in the caller's TransactionScope. It writes no state;
P10 reads no P3/P4 private store directly. P10/05 returns an ephemeral
Workspace Detail `sandboxPolicyCandidateRead` in place of the singular V21
preconditions when a human must make an initial or refreshed choice. It
contains the common exact preconditions and closed candidate list; P5 supplies
only the validated immutable authority snapshot and supported host tuples;
P10 filters Workspace applicability; P13 maps deliberate selection to the
existing P1 command. Candidate ID is display identity only, never P1 payload
or CAS authority. Existing POST route, command, codecs, receipts, migration
prefix and all P3/P4/P9 execution gates remain unchanged.

## Implementation authorization and non-goals

This is owner-contract acceptance only. It grants no implementation, test,
database, migration, provider qualification, or release authority. The
combined V3/HWA V2/Candidate V5 owner landing has passed independent
post-review; this V5 acceptance itself grants no new implementation
authorization. No new endpoint, wire field, persisted candidate, durable
fact, table, or migration is added.

## Owner scope and review

The owner changes are P4/05/06, P10/03/05, P1/01, P5/01 and P13/03/06, with
contract-index/dependency cross-references. DID is advanced to 1.56 only as a
cross-owner version summary; Scenarios 1.6 and System Design 1.21 are
unchanged. Independent post-landing review is PASS (B0 = 0, B1 = 0, B2 = 0),
recorded in
`planning/results/native-os-sandbox-v21-producer-and-candidate-read-postlanding-review.result.md`,
raw SHA-256 `E35DEC30C5CE09DD2CD0DC34B77B42025FBCA86B50CB2B1688A3854BE48B3002`.
