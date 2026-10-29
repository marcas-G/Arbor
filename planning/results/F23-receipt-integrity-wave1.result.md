# F23 Receipt Integrity — Wave 1

Status: implemented in this isolated candidate; not merged or pushed.

## Scope and behavior

The Gateway keeps its frozen exact-tuple ordering: after `findResolution`, it
compares the stored fingerprint, handler schema version, and fingerprint
algorithm version before interpreting stored JSON. A mismatch still returns
`IdempotencyConflict` without decoding the stored result. Only an exact tuple
uses the new command-specific runtime decoder.

The decoder covers schema version `1` for all 26 command types in
`CommandInputContractRegistry`, validating exact DTO keys, current primitive,
ordinal, ID and tagged-union shapes. It separately validates the complete
current `CommandRejection` union, including all required fields, and rejects
extra keys and prototype-inherited tags. `ConcludeVerificationResult` accepts
the frozen optional `conclusionReason`; because JSON omits `undefined`, a
valid stored DTO without that key is returned with
`conclusionReason: undefined`.

Malformed JSON, invalid DTO shape, invalid rejection shape, resolution/JSON
column disagreement, or an unsupported registered schema maps to a fixed,
non-disclosing `PersistenceCorruption` (`CommandStore`, `decodeReceipt`). The
existing transport maps that to the safe non-retryable
`persistence/corruption` Problem. This failure occurs inside the existing
transaction body; it does not invoke a handler or write a receipt, event, or
attempt. The P1 regression keeps an unparsable raw result on a mismatching
tuple and confirms the conflict branch remains tuple-first.

## Qualification

- `pnpm typecheck` — PASS.
- Biome on the four changed TypeScript files — PASS.
- `tests/application/command-result-codec.test.ts` — 4/4 PASS, including
  positive schema-v1 examples for all 26 registered command result DTOs,
  positive decoding of all current rejection tags, malformed/unknown schema
  failure, inherited-tag rejection, and schema-version prototype-key rejection.
- `packages/application/test/p1-gateway.test.ts` focused
  “compares a stored tuple before interpreting its raw result JSON” — 1/1
  PASS.
- `tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts`
  focused Committed and TerminalRejected wrong-shape HTTP cases — 2/2 PASS.
  Both assert the safe 503 Problem, no leaked sentinel, unchanged receipt /
  attempts / events, and no daemon errors.
- Full `pnpm check` was not run.

## Explicit boundaries / follow-up

- AH10 `control-actions.ts` prior-receipt decoding and P9 direct-child A1
  durable `ReceiptMismatch` disposition remain Wave 2. This change does not
  alter the generic prior-receipt decoder or claim those cases closed.
- P10 operator-visible diagnostic/Attention delivery remains OPEN; this
  implementation only returns the existing safe operational Problem and does
  not introduce an Attention source or diagnostic port.
- The current baseline's rejection union contains 30 tags. A concurrent F21
  candidate adds `ProjectResourceUnavailable{commandId}` in its isolated tree;
  that member is intentionally not guessed into this baseline. Its union
  addition must be merged together with a strict decoder/sample, enforced by
  the exhaustive `Record<CommandRejection["_tag"], Validator>` check.
- No design documents, transport adapters, production result writers, or
  receipt storage adapters were changed.

### Supplemental prototype-key regression

The first RED run used exact stored schema versions `constructor` and
`toString` with a Committed `{}` result. The `constructor` case was incorrectly
accepted because ordinary object property lookup returned an inherited
function. The decoder now requires the version to be an own key of the
command's schema map before retrieving its validator; both schema-version
cases now fail closed. This does not change Gateway tuple ordering.

F21 integration adds another explicit compatibility task: in addition to its
`ProjectResourceUnavailable{commandId}` rejection member, the CreateProject
handler schema-v2 result requires its own positive decoder/example. This
Wave1 candidate only supports the baseline's schema-v1 command/result pairs;
it does not claim cross-schema replay qualification.
