# F23 Exact-Tuple Receipt Integrity — Runtime Implementation

Status: **authorized implementation complete for the fixed runtime scope; F23 is not thereby closed**

Implementation baseline: `fccd1c14`

Authorization token: `AUTHORIZE_F23_EXACT_TUPLE_RECEIPT_INTEGRITY_RUNTIME_IMPLEMENTATION`

Accepted plan SHA-256 (raw Git blob bytes): `D54BC63D2517DFCDF864DA63C8C5776DC51D07F06379ECDF5DF03876AC1F86D5`

## Implemented

- Added strict Committed DTO and complete `CommandRejection` union decoding keyed by the trusted command type and Handler schema version. The closed decoder inventory covers 28 required P13 external descriptors, optional `ResolveControlApproval`, and internal `UpdateResourceBoundary`; unsupported command/version, malformed JSON, wrong resolution columns, missing/extra fields and invalid union members fail with the fixed non-disclosing `PersistenceCorruption<"CommandStore">`.
- Gateway keeps the existing `BEGIN IMMEDIATE` tuple comparison before decoding. Tests prove that a mismatch with corrupt JSON still returns `IdempotencyConflict`, while an exact-tuple corrupt row fails closed without changing receipt bytes, attempts, events or handler effects.
- All six AH10 prior-consumer routes use their caller-supplied CommandType and trusted Handler registry schema: AssignWork paths, AcceptResult, SendMessage, SelectCurrentWork, DeclareDependency and ProduceDeliverable. Current-Workspace AssignWork authorization now receives that same trusted registry from composition. Ordinary prior-receipt corruption remains an operational failure.
- Direct-child AssignWork retains its P9-specific boundary: A1 syntax corruption and A2 parseable wrong shape enter the existing `ReceiptMismatch` fact/event path; the process qualification covers both sides of the fact commit and recovery. P9 fact-write failure rolls back and fails closed. No JSON/parser detail is written to facts or exposed.
- Updated the pending F23 SQLite cases to use owned schema-44 fixtures. No design document, migration, database upgrade or P10 corruption source was added.

## Verification

- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS; the existing bundle-size advisory remains. This creates the static Web root required by the public-process fixture.
- `pnpm typecheck` — PASS (`tsc -b` and test typecheck).
- Biome on all changed TypeScript files — PASS; `git diff --check` — PASS.
- Codec tests accept one current positive DTO for every registered receipt descriptor, including all 28 required external pairs, optional `ResolveControlApproval`, and internal `UpdateResourceBoundary`; rejection-union and malformed-row negatives also pass.
- Codec, Gateway, AssignWork replay, AH10 takeover, and Deliver replay suites — 6 files / 81 tests PASS. The AH10 takeover cases cover the prior-consumer action routes.
- `tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts` — 9/9 PASS: exact Committed/TerminalRejected public corruption, AH10 prior AssignWork wrong shape, the five direct-child P9 vectors, and P9 sink rollback.
- `tests/functional/process/f23-receipt-tuple-ordering.functional.test.ts` — 5/5 PASS, including Resolver visibility, mismatch priority and both corruption classes.
- `tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts` filtered to `corrupt-result-before|corrupt-result-after|wrong-shape-result` — 3/3 PASS.
- Full `pnpm check` and full `pnpm test:functional` were not run under this authorization plan.

The first fixture attempts exposed two setup issues and were not counted as PASS: the new authorizer dependency had not been supplied in the composition root, and public readiness returned 503 because `apps/web/dist` had not been built. Both were corrected; the bounded process suites above were rerun successfully. The pending tests also formerly applied the P34 migration prefix to schema-44 databases; those cases now start from the schema-44 fixture instead.

## Supplemental AH10 prior-consumer corruption matrix

The route-level matrix was added after review found that the original AH10
tests exercised valid takeover receipts but did not inject every corruption
class into every named consumer. Each of these eight route variants is now exercised
against malformed JSON, parseable wrong shape, unsupported stored schema
version, mismatched CommandId and mismatched ProjectId:

- Current-Workspace AssignWork authorizer and generic AssignWork action
  takeover.
- AcceptResult, SendMessage, SelectCurrentWork, DeclareDependency and
  ProduceDeliverable.
- Direct-child AssignWork's dedicated P9 `assignWorkReplay` route.

For the six ordinary prior-consumer paths, the raw malformed JSON used for
identity-mismatch cases proves that identity is checked before decode. Those
cases assert the identity-specific failure cause; bad JSON/shape/version assert
the fixed CommandStore corruption cause. Every case asserts no new Gateway
Command or Observation; SendMessage asserts no Blob write, SelectCurrentWork
asserts no Decision submission, and current-Workspace AssignWork asserts no
permission/grant/approval lookup or write. Each lookup reads only the one
derived prior CommandId. Every vector now compares a deep-cloned full receipt
snapshot taken before handler execution with a separately cloned post-handler
row, including CommandId, ProjectId, schema version, result/error JSON,
fingerprint metadata, resolution and timestamps.

The direct-child P9 cases assert that syntax corruption, bad shape and
unsupported stored version record exactly one existing `ReceiptMismatch`
fact and end `AgentActionRecoveryBlocked`; CommandId/ProjectId mismatches stop
before the P9 sink and end as operational failure. All five assert no Gateway
submission, no leaked sentinel and no source-row mutation. The earlier real
process A1/A2 commit-before/after qualification and sink rollback qualification
remain in force. These in-memory cases also compare a complete deep-cloned
receipt snapshot before and after execution for every vector.

Targeted verification after this supplement:

- `apps/single-workspace/test/ah10-generation-command-takeover.test.ts` plus
  `apps/single-workspace/test/ah10-current-workspace-assign-work-receipt-replay.test.ts`
  — 54/54 PASS; this includes 30 ordinary-route corruption combinations
  across AssignWork, AcceptResult, SendMessage, SelectCurrentWork,
  DeclareDependency and ProduceDeliverable, plus five current-Workspace
  AssignWork authorizer cases. Identity mismatch fixtures contain malformed
  JSON but report the identity-specific error before decoder lookup.
- The complete pending F23 file — 9/9 PASS; its direct-child parameterized
  cases cover malformed JSON, wrong shape, unknown schema, CommandId mismatch
  and ProjectId mismatch. The first three preserve the P9 fact/RecoveryBlocked
  route; the last two fail before the P9 sink.
- `pnpm typecheck` and Biome on the changed route tests — PASS.

## Boundaries

This result qualifies the authorized exact-tuple decoder and the specified prior-consumer/P9 routing. It does not qualify cross-schema-version receipt fallback, online or preserved-database behavior, P10 corruption Attention/diagnostics, AH7/AH10/AH14 closure, or overall F23 release closure. Unsupported stored schema versions fail closed. No full release claim is made.
