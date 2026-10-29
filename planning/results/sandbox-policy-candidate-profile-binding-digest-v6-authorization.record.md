# Sandbox Policy Candidate Profile Binding Digest V6 — Implementation Authorization

**Date:** 2026-10-19

**Implementation token:** `AUTHORIZE_SANDBOX_POLICY_CANDIDATE_PROFILE_BINDING_DIGEST_V6_IMPLEMENTATION`.

**Authorized fixed addendum:**
`planning/tasks/sandbox-policy-candidate-profile-binding-digest-v6-implementation-addendum-v2.md`.

**Accepted addendum normalized-LF SHA-256:**
`294372594599FE130A9F83D8249B7DCFF49E63E84FF4BA198BACBA3E5D3FD952`.
The Windows checkout uses CRLF worktree bytes; the accepted hash was verified
over the exact UTF-8 content with CRLF normalized to LF.

**Accepted proposal SHA-256:**
`90300163BA7F2EE31314E63A028A3D67F9DD87D79895796F6DB81304D846DCB2`.

**Owner landing:** `24307d68d8f6d080aa42cecf727101b94ec8dbdc`; the independent
post-landing review reports B0/B1/B2 = 0 and Blocking = 0 in
`planning/results/sandbox-policy-candidate-profile-binding-digest-v6-postlanding-review.result.md`.

**Underlying V5 fixed-plan Git-blob SHA-256:**
`B99C2682F30F277AA9E3C7C135E4A8A2C5C5811C3B44C380604ABB3B6F1CC3B9`.
V5 implementation authorization and V5-A integration are recorded in
`planning/results/sandbox-policy-candidate-readmodel-v5-a-authorization-and-integration.record.md`.

## Scope for this implementation slice

This record authorizes the exact V6 delta layered on the accepted V5 plan.
The current slice implements only addendum DAG slices A–C:

- move the handle-binding digest from candidate common preconditions to each
  closed candidate variant, preserving `spc2_` identity preimages;
- update the API/projection shape mirrors and their strict closure tests;
- implement a same-transaction P10/P11 read seam supplying the complete
  current Workspace/boundary/resolved-region/ownership/primary-worktree
  evidence and reuse `produceSandboxBoundaryV1` per offered profile, with
  typed all-or-nothing failure.

P13/Web selection, P1 CAS work, production sandbox-process-policy wiring,
real dual-daemon qualification, and overall V5/V6 closure remain later
authorized DAG slices and are not claimed here. No docs/design, schema,
migration, P1 wire, authority, provider qualification, or permission boundary
changes are included. A new semantic contradiction must return to Design Gap
governance.
