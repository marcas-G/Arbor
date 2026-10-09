# FT-DG-03 Accepted Design Landing: Independent Semantic Review

Date: 2026-10-09

Review scope: read-only post-landing consistency review of the accepted FT-DG-03
package. This review covers accepted proposal SHA-256
`DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`, its
21 owner-file landing, the recorded SD/DID revisions, registry scope, and the
preserved AH10/F21 boundaries. It does not authorize implementation.

## Result

**Blocking = 0.** The accepted package is reflected consistently in the landed
design. The independent check recomputed the proposal SHA and all 21 owner-file
SHA-256 values recorded in
`FT-DG-03-governance-acceptance-and-landing.md`; every digest matched. The
current `docs/design/**` diff contains exactly those 21 owner files. SD is
v1.12; DID is v1.34 and depends on SD v1.12.

## Semantic checks

- The landing preserves the accepted fixed external wire v1 without a
  caller-supplied version field and keeps codec version, Handler schema
  version, and fingerprint algorithm version distinct. Strict decoding and
  exact external Actor/Principal binding precede Resolver visibility; no
  receipt is read outside the Gateway.
- P1's receipt rule remains exact-tuple replay/conflict inside the existing
  `BEGIN IMMEDIATE` transaction. The Gateway's receipt-first order inside the
  transaction remains ahead of final authority validation. This keeps the
  external Resolver visibility gate distinct from the Gateway's mutation and
  receipt boundary.
- `InvalidCommandPayload` is a transport-only, non-reflecting Problem with
  HTTP 400. Invalid input fails before Resolver/Gateway and creates no receipt,
  attempt, event, or canonical mutation. Typed internal payload failures are
  contract defects/Attention, not authority denials or model-retryable
  rejections.
- Malformed historical CommandIds and payloads are preserve-only and
  non-replayable. They are rejected before receipt lookup; existing rows are
  left unchanged. No raw payload, new receipt comparator, or F23 migration is
  introduced.
- The 26-command production list matches the composed
  `SingleWorkspaceCommandHandlerRegistryLive` list; production composition
  supplies `ControlApprovalStore`, so the conditional
  `ResolveControlApproval` handler is present in that composition. The six
  listed factories (`ReviseDependencyContract`, `WithdrawDependency`,
  `MarkDependencyUnfulfillable`, `RegisterProjectTool`, `CreateWorktree`, and
  `RetireWorktree`) are not part of that registry and remain factory-only.
  P13 separates this codec registration list from UI exposure.
- AH10 remains a dependency baseline: SD §4.11, DID §6A.16 / §9.3 migration
  0033 / §9.9, P1 `07`, and the direct-child AssignWork exception are preserved.
  The F23 design adds no external AssignWork evidence or alternate recovery
  route. F21 and FT-DG-01 remain isolated.

## Scope and authorization

No F23 production-code or test file appears in the current diff. Separate
AH10/P9 source and test changes are present in the shared working tree, but
they are outside the 21-file design landing and were not treated as evidence
for this review. No tests were run. The accepted landing record explicitly
states that runtime implementation is **not authorized**; separate
implementation authorization remains required.

The accepted proposal snapshot still contains “DRAFT / awaiting human
acceptance” wording (including its closing statement that choices are not yet
accepted). These are stale status phrases in the immutable accepted snapshot;
the explicit acceptance token and accepted SHA in the landing record supersede
them. They do not change the landed contract. The landing record also notes
that current transport code does not yet map the validation category to HTTP
400. That is an implementation item for a separately authorized task, not a
design-landing blocker.

## Verification performed

- Recomputed accepted proposal SHA-256: exact match.
- Recomputed all 21 accepted owner-file SHA-256 values: 21 matches, 0
  mismatches.
- `git diff --name-only -- docs/design`: exactly the 21 accepted owner files.
- `git diff --check -- docs/design`: passed.
- No tests or implementation checks were run; implementation remains
  unauthorized.
