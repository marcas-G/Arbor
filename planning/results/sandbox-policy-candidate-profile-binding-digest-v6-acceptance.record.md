# Sandbox Policy Candidate Profile Binding Digest V6 — Acceptance and Landing Record

**Decision date:** 2026-10-19

**Decision:** Manual governor accepted
`ACCEPT_SANDBOX_POLICY_CANDIDATE_PROFILE_BINDING_DIGEST_V6`.

**Accepted proposal raw SHA-256:**
`90300163BA7F2EE31314E63A028A3D67F9DD87D79895796F6DB81304D846DCB2`.

**Accepted proposal path:**
`C:\Users\ThinkPad\.codex\worktrees\native-sandbox-implementation\Arbor\planning\proposals\sandbox-policy-candidate-profile-binding-digest-governance-v6.md`.

**Owner base:** `dbe05ab4155aa08c3909135413241d79f2327d20`
(DID v1.56).

## Accepted semantic delta

The V5 candidate read's common `sandboxHandleBindingDigest` is relocated to
each closed candidate variant, immediately after `candidateId`. P10 derives
each digest from that profile's exact P4 `SandboxHandleBindingDigestV1`
projection over the complete current P11 ResourceBoundary and active exact
Workspace ResourceOwnership under one coherent read barrier. Initial and
refreshed reads use current source facts; a missing, corrupt, ambiguous or
unprovable projection fails the whole read with a typed error. Candidate
digests may coincide when their derived mounts and access coincide.

After affirmative human selection, P13 maps only the selected candidate's
digest to P1's existing `expectedSandboxHandleBindingDigest` and keeps the
existing variant and registry mappings. P1's profile-specific CAS and stale
receipt are unchanged. `candidateId` retains its V5 tuple-only presentation
preimage, so a changed digest can retain the same ID. A stale receipt requires
whole-list refetch and a new deliberate human choice even in that case.

The singular V21 `sandboxPolicyPreconditions` union is unchanged. The V5
P4 requirement proof, P5 full V2 bundle/host tuple proof, P4/P9 execution
gates, candidate ordering/deduplication, safe redaction and separate
TrustedLocal high-risk confirmation remain in force. No P1 wire/codec,
fingerprint, rejection, event, committed snapshot, table or migration changes.

## Scope and authority

Owning revisions are DID v1.57, P4/05, P10/05, P13/03/06 and P1/01,
with their P1/P4/P10/P13 contract indexes. Scenarios remain 1.6 and System
Design remains 1.21. This acceptance authorizes exactly the design landing;
implementation authorization is separate. No code, test, migration, database,
deployment or release change is part of this landing.

The adjacent manifest pins base blobs and raw postimage SHA-256 hashes.
Independent post-landing consistency review of
`24307d68d8f6d080aa42cecf727101b94ec8dbdc` is complete:
B0 = 0, B1 = 0, B2 = 0, Blocking = 0. The reviewer-reported scope and
postimage-hash checks are archived in
`planning/results/sandbox-policy-candidate-profile-binding-digest-v6-postlanding-review.result.md`
(raw SHA-256
`9CE4955D4D2CF7CBB197E622E47C69AA68E5A6B732C9E06BD690F9E3F046A0A3`).
The independent reviewer produced no separate repository artifact; the
linked result records the relayed outcome. The review does not authorize
implementation.
