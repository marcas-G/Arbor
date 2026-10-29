# F23 Exact-Tuple Receipt Integrity — Implementation Plan Record

Date: 2026-10-16
Planning baseline: `367fd9a3d064409b77b03bcab4ba26703d0a32b8`
Status: **planning only; implementation authorization pending**

Plan: `planning/proposals/F23-exact-tuple-receipt-integrity-runtime-implementation-plan.md`
Requested token: `AUTHORIZE_F23_EXACT_TUPLE_RECEIPT_INTEGRITY_RUNTIME_IMPLEMENTATION`
Raw plan SHA-256: `D54BC63D2517DFCDF864DA63C8C5776DC51D07F06379ECDF5DF03876AC1F86D5`

## Governance and authorization boundary

DID v1.35 and the P1 `01/02/03/07` plus P9 `07` owner landing already accept
strict tuple-first Committed/TerminalRejected decoding and the AH10 prior
consumer/P9 disposition. The landing explicitly does not authorize runtime
implementation or crash qualification. This plan therefore requests a separate
implementation authorization; it does not claim the token has been accepted.

The plan is bounded to the current 28 required P13 command descriptors and the
optional `ResolveControlApproval` descriptor only when composed; it separately
requires receipt decoders for receipt-writing internal CommandHandlerRegistry
entries such as `UpdateResourceBoundary`, without counting them as P13 external
descriptors. It preserves Gateway's existing `BEGIN IMMEDIATE` tuple comparison and `CommandStore` raw
JSON boundary; it introduces no schema/migration, online DB operation, P10
source, operator diagnostic sink or cross-schema-version fallback. Existing
Wave1/2 candidate evidence is noted as baseline but must be requalified against
this exact 28+optional29 integration HEAD before closure claims.

The plan resolves no new semantic question. If baseline inventory finds a
command result shape not determinable from accepted Command contracts and
existing writer serialization, halt that decoder and request manual governance
rather than guessing.

## Preparation checks

- Files added: the fixed implementation plan and this result record only.
- No `docs/design/**`, production code, tests, migrations, databases or
  deployment targets were changed or run.
- No tests or build were run for this planning-only package.
- Diff-check and raw SHA are recorded after final text stabilization.
