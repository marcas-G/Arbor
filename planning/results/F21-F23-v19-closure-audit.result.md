# F21 / F23 v19 Closure Audit

Baseline: `ed5fba00ee60e169cadf0df12395179862abd1e8` (clean detached
worktree at task start). This report records implementation ownership,
accepted boundaries, and work added in this isolated branch. It is not a
design acceptance, release qualification, or F21/F23 closure declaration.

## F21 module inventory

| Module | Current contract / implementation | State after this audit |
|---|---|---|
| Host Profile catalog and CreateProject v2 | P1 CreateProject v2 and `ProjectResourceProfilePort`; P12 path-free host catalog; handler persists the canonical Workspace boundary. | Implemented. F21 Wave A/B results and current source cover admission, closed Profile/ConversationOnly selector, raw-path rejection, and receipt replay. |
| Browser selection and golden journey | Wave C moves F21 into `tests/functional/ui/f21-project-resource.spec.ts`; the default Playwright config includes `tests/functional/ui`. It proves Profile selection, file-backed Verification/Acceptance, and forged-ref/path rejection. | Targeted qualification is recorded in Wave C; this audit did not rerun Playwright while the central release gate owned test resources. |
| Post-commit activation and P10 Attention | Accepted OPEN-3 owner landing adds the durable intent, Pending/Active event, startup recovery, and source-specific path-free Attention projection. P10 Story L process evidence records rebuild and offset behavior. | Implementation evidence exists. The prior final review is pinned to an earlier integrated commit and does not replace current release qualification; this audit makes no new formal OPEN-3 closure claim. |
| OPEN-1 Profile-source audit | Project/Workspace retain the canonical boundary, but no durable Project-readable record distinguishes which Profile ref/version was selected. The current v3 design leaves this requirement undecided. | **Open governance decision.** Draft recommends a Project-owned `Profile(ref, version) | ConversationOnly | LegacyUnknown` source value, with old Projects `LegacyUnknown`, no path in reads, and no ProjectCreated event-version change. No implementation or design-file edit. |
| OPEN-2 historical v1 same-ID success | Current CreateProject Handler/codec is v2. A legacy raw-address payload is not a current wire request; there is no old-schema decoder or same-ID pre-read branch. | **Open product decision.** Draft recommends preserve-only history and no successful v1 replay, consistent with F23 tuple precedence. No legacy replay implementation or design-file edit. |

Proposal: `planning/proposals/F21-open1-open2-closure-decision-draft.md`.
It requires explicit manual acceptance before any owner-contract landing or
implementation. A green Profile browser journey alone does not close the
audit or upgrade-compatibility questions.

## F23 module inventory

| Module | Current contract / implementation | State after this audit |
|---|---|---|
| Wire/runtime validation | The FT-DG-03 v1.34 landing fixes the external codec, Actor/Principal binding, Resolver visibility, registered command set, and non-reflecting validation error. | Runtime implementation is present in the v19 tree. The historical landing record itself said implementation was not authorized at landing time; the parent task separately directs this implementation audit. |
| Gateway receipt tuple and exact decode | `packages/application/src/gateway.ts` compares fingerprint, Handler schema, and fingerprint-algorithm version before interpreting raw receipt JSON; `command-result-codec.ts` uses the trusted command/schema decoder table and strict complete rejection union. | Implementation present. Added unit coverage rejects missing and extra fields for every registered result DTO. Existing tests include positive examples for every registered result and preserve-only/unsupported schemas. |
| Prior-generation receipt consumers | `control-actions.ts` selects CommandType/schema from the typed route and registered Handler; direct-child AssignWork corrupt receipt handling goes through its existing P9 ReceiptMismatch fact path. | Implementation present. Added unit coverage that unsupported older versions for each of six prior-consumer routes fail closed. The P9 fact/Attention contract remains the narrow existing AH10 route. |
| Public-process receipt corruption | Default process file already proves tuple mismatch precedes raw JSON decoding and exact-tuple syntax corruption fails closed. | Added two default-process scenarios for exact-tuple, syntactically valid wrong-shape Committed result and TerminalRejected error; they assert the safe non-retryable Problem, no sentinel disclosure, byte-identical receipt, and no attempts/events. The new scenarios await qualification. |
| Cross-schema prior replay | P1 `07` selects only the trusted current route schema; an unsupported stored version has no fallback decoder. | No historical decoder was added. Successful cross-version replay remains unsupported; explicit compatibility mappings require separate governance. Added unit coverage for fail-closed unsupported versions; qualification awaits the central test window. |
| P10 corruption signal / diagnostics | DID/P1/P9 accepted exact-tuple landing explicitly adds no generic CommandStore-corruption Attention source and no diagnostic port. Direct-child AH10 P9 facts continue to the existing Action Required projection. | Generic Gateway corruption remains a safe non-retryable operational Problem; no new P10 source. A separate operator-visible diagnostic sink remains an external decision and is not represented as closed. |

## Verification in this audit

- `pnpm install --frozen-lockfile --offline` — completed in this worktree.
- `pnpm build` — passed.
- `pnpm typecheck` — passed, including the two changed test files.
- Biome check on `tests/application/command-result-codec.test.ts` and
  `tests/functional/process/f23-receipt-tuple-ordering.functional.test.ts` —
  passed.
- One local two-file Vitest command was interrupted immediately after the
  parent announced its exclusive release-gate window. Vitest had printed 27
  passed tests, but the process exited 1 due to Ctrl+C; **it is not counted as
  a pass**. No daemon, browser, or public-process qualification was started by
  this audit.

The central release gate must run the updated public-process file after these
changes are integrated. Formal F21 OPEN-1/OPEN-2 acceptance and F23 cross-schema
compatibility/diagnostic decisions remain external governance inputs.
